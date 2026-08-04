import admin from "firebase-admin";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({});

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

if (
  !process.env.FIREBASE_PROJECT_ID ||
  !process.env.FIREBASE_CLIENT_EMAIL ||
  !process.env.FIREBASE_PRIVATE_KEY
) {
  throw new Error("Missing Firebase environment variables");
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

function getBearerToken(event) {
  const authHeader =
    event?.headers?.Authorization || event?.headers?.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length).trim();
}

export const handler = async (event) => {
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