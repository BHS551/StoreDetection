# StoreDetection

Lambda de **SkyEye** que guarda un evento de detección. Es el endpoint
`storeRegister` que invoca el worker (`heimdall-eye.py`) cada vez que dispara
una alerta.

> 📚 Contexto completo del proyecto: `docs/SKYEYE_PROJECT.md` en el repo
> `harmsDetectionLandingUi`.

## Qué hace

`POST` (con `Authorization: Bearer <ID token Firebase>` — el worker se
autentica con un custom token de servicio, uid `heimdall`):

1. Guarda en DynamoDB (`detections`, item `type: "event"`):
   - `id` = `<ISO timestamp>-<sufijo aleatorio>`
   - `raw` = body completo del worker (cámara, `event_type`, `cosine_sim`,
     `image_key` del frame en S3, `detection_id`, …)
   - `owner_uid` = del body si viene (lo pone el worker), o el uid del token.
   - `expireAt` = **TTL de 30 días** (los frames en S3 caducan a los 7). Solo
     los eventos llevan TTL; los devices de la misma tabla no expiran.

## Detalles

- Endpoint conocido: `https://c038gkbfm8.execute-api.us-east-1.amazonaws.com/default/storeRegister`.
- No se loguea el evento ni el body (incluyen el token y datos del usuario).
- Credenciales de Firebase desde Secrets Manager (`heimdall/firebase`), con
  fallback a env vars para rollback.
- CORS restringido (configurable con `ALLOWED_ORIGINS`); solo errores `auth/*`
  devuelven 401.

## Variables de entorno

`FIREBASE_SECRET_ID` (default `heimdall/firebase`), `ALLOWED_ORIGINS`,
`AWS_REGION` (default `us-east-1`).

## Relacionados

- `harmsDetection` — el worker que invoca este endpoint.
- `ListDetections` — lee estos eventos para la consola.
