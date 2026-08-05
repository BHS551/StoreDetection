import admin from "firebase-admin";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({});

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

// firebase-admin: la credencial se lee de Secrets Manager (heimdall/firebase)
// en lugar de variables de entorno. Cae a las env vars solo si el secreto no
// está disponible, para permitir un rollback seguro.
const secretsClient = new SecretsManagerClient({
  region: process.env.AWS_REGION || "us-east-1",
});
const FIREBASE_SECRET_ID = process.env.FIREBASE_SECRET_ID || "heimdall/firebase";

let firebaseReady = null;
function ensureFirebase() {
  if (!firebaseReady) {
    firebaseReady = (async () => {
      if (admin.apps.length) return;
      let sa = null;
      try {
        const res = await secretsClient.send(
          new GetSecretValueCommand({ SecretId: FIREBASE_SECRET_ID })
        );
        const secret = JSON.parse(res.SecretString);
        sa = secret.service_account || secret;
      } catch (e) {
        if (!process.env.FIREBASE_PRIVATE_KEY) throw e;
      }
      const credential = sa
        ? admin.credential.cert({
            projectId: sa.project_id,
            clientEmail: sa.client_email,
            privateKey: sa.private_key,
          })
        : admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
          });
      admin.initializeApp({ credential });
    })();
  }
  return firebaseReady;
}

// CORS: refleja el origen solo si está permitido (dominio de la app + previews
// de Vercel + localhost). Configurable con ALLOWED_ORIGINS (lista separada por
// comas). Antes se enviaba "*" a cualquier origen.
const STATIC_ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DEFAULT_ORIGIN =
  STATIC_ALLOWED[0] || "https://harms-detection-landing-ui-seven.vercel.app";
function allowOrigin(event) {
  const origin =
    event?.headers?.origin || event?.headers?.Origin || "";
  const ok =
    STATIC_ALLOWED.includes(origin) ||
    /^https:\/\/([a-z0-9-]+\.)*vercel\.app$/i.test(origin) ||
    /^http:\/\/localhost(:\d+)?$/i.test(origin);
  return ok ? origin : DEFAULT_ORIGIN;
}

function getBearerToken(event) {
  const authHeader =
    event?.headers?.Authorization || event?.headers?.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length).trim();
}

export const handler = async (event) => {
  headers["Access-Control-Allow-Origin"] = allowOrigin(event);
  if (
    event?.requestContext?.http?.method === "OPTIONS" ||
    event?.httpMethod === "OPTIONS"
  ) {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    const token = getBearerToken(event);
    if (!token) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ message: "Unauthorized: missing token" }),
      };
    }

    // No se loguea el evento ni el body: el evento incluye el header
    // Authorization (token Firebase) y el body datos del usuario.
    await ensureFirebase();
    const decodedToken = await admin.auth().verifyIdToken(token);

    const bodyText = event.body || "";

    let body = {};
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch (e) {
        console.warn("JSON parse error:", e.message);
      }
    }

    // Usar owner_uid del body si existe, sino usar el uid del token
    const ownerUid = body.owner_uid || decodedToken.uid;

    const now = new Date().toISOString();
    const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;

    const item = {
      type: { S: "event" },
      id: { S: id },
      created_at: { S: now },
      raw: { S: bodyText || JSON.stringify(body) || "{}" },
      owner_uid: { S: ownerUid },
    };

    await client.send(
      new PutItemCommand({
        TableName: "detections",
        Item: item,
      })
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, id }),
    };
  } catch (err) {
    const isAuthError = err?.code?.startsWith?.("auth/") === true;

    console.error("Error:", err?.message ?? err);
    return {
      statusCode: isAuthError ? 401 : 500,
      headers,
      body: JSON.stringify({
        message: isAuthError ? "Unauthorized" : "Error saving detection",
        error: err?.message ?? "Unknown error",
      }),
    };
  }
};