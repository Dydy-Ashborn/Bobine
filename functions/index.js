/* ================================================================
   Bobine — Cloud Functions
   Un seul chantier pour l'instant : l'achat unique "Retirer les pubs"
   (Stripe Checkout, mode payment, jamais subscription — voir decisions
   du bloc Firebase/Stripe des instructions de projet).

   Pourquoi un backend est incontournable ici : le champ sansPub ne doit
   jamais être modifiable directement par le client (voir firestore.rules,
   qui l'interdit explicitement) — seul ce code, via l'Admin SDK après
   vérification de la signature du webhook Stripe, a le droit de le poser
   à true. Un site 100% statique ne peut pas garantir un paiement tout
   seul, quelle que soit la façon dont on essaierait de le bricoler.
   ================================================================ */
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

const REGION = "europe-west1"; // cohérent avec le choix de région du reste du projet
const PRIX_SANS_PUB_CENTIMES = 299; // 2,99 € — voir décision produit

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new HttpsError("failed-precondition", "Stripe non configuré côté serveur.");
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// Valide grossièrement l'URL de retour fournie par le client (juste pour
// éviter qu'un success_url/cancel_url complètement absurde soit envoyé à
// Stripe — pas une vraie surface de risque vu le nombre d'utilisateurs de
// l'app, mais autant ne pas transmettre n'importe quoi tel quel).
function sanitizeReturnOrigin(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
      throw new Error("protocole non autorisé");
    }
    return `${url.origin}${url.pathname}`;
  } catch (e) {
    throw new HttpsError("invalid-argument", "URL de retour invalide.");
  }
}

/* ----------------------------------------------------------------
   createCheckoutSession — callable, appelée depuis le front (voir
   window.BobineCloud.buyRemoveAds dans index.html). Crée une session
   Stripe Checkout hébergée (pas de Stripe.js côté client : on redirige
   simplement vers session.url) et renvoie l'URL à suivre.
   ---------------------------------------------------------------- */
exports.createCheckoutSession = onCall({ region: REGION }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Connexion requise.");
  }
  const uid = request.auth.uid;
  const returnUrl = sanitizeReturnOrigin(request.data && request.data.returnUrl);

  const statusSnap = await db.collection("users").doc(uid).collection("private").doc("status").get();
  if (statusSnap.exists && statusSnap.data().sansPub) {
    throw new HttpsError("failed-precondition", "Déjà sans publicité sur ce compte.");
  }

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "eur",
          product_data: { name: "Bobine — Retirer les publicités" },
          unit_amount: PRIX_SANS_PUB_CENTIMES
        },
        quantity: 1
      }
    ],
    // client_reference_id ET metadata.uid : redondant volontairement, le
    // webhook lit l'un ou l'autre selon ce que Stripe fournit de façon la
    // plus fiable pour ce type d'événement.
    client_reference_id: uid,
    metadata: { uid },
    success_url: `${returnUrl}?sansPubMerci=1`,
    cancel_url: `${returnUrl}?sansPubAnnule=1`
  });

  return { url: session.url };
});

/* ----------------------------------------------------------------
   stripeWebhook — endpoint HTTP brut (pas onCall : Stripe n'est pas un
   client Firebase authentifié). La vérification de signature est ce qui
   garantit que seul Stripe peut réellement déclencher le passage en
   sansPub:true.
   ---------------------------------------------------------------- */
exports.stripeWebhook = onRequest({ region: REGION }, async (req, res) => {
  const stripe = getStripe();
  const signature = req.headers["stripe-signature"];

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    logger.error("STRIPE_WEBHOOK_SECRET manquant — impossible de vérifier la requête.");
    res.status(500).send("Webhook non configuré.");
    return;
  }

  let event;
  try {
    // req.rawBody : fourni automatiquement par Cloud Functions pour les
    // fonctions HTTP, indispensable ici — Stripe signe le corps brut, pas
    // le JSON reparsé.
    event = stripe.webhooks.constructEvent(req.rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error("Signature webhook Stripe invalide:", err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const uid = session.client_reference_id || (session.metadata && session.metadata.uid);
    if (uid) {
      // Sous-collection "private", jamais le document users/{uid} public :
      // voir firestore.rules, personne d'autre que ce uid ne peut la lire,
      // et même lui ne peut pas y écrire — seule l'Admin SDK ici le peut.
      await db.collection("users").doc(uid).collection("private").doc("status").set(
        { sansPub: true, sansPubAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      logger.info(`sansPub activé pour uid=${uid} (session ${session.id})`);
    } else {
      logger.error(`checkout.session.completed sans uid identifiable (session ${session.id})`);
    }
  }

  res.json({ received: true });
});
