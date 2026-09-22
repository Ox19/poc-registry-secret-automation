# Registro de secretos en Azure Key Vault

El valor va **directo de su origen a la bóveda, en un solo salto**, y quien lo escribe no puede leerlo
después. Todo entra por **GitHub Actions**: se pide en un issue, un analista aprueba, y `github[bot]`
lo escribe en el Key Vault sin que nadie —ni el propio pipeline— pueda verlo. Nadie usa el portal de
Azure.

> **Laboratorio.** Corre contra un Azure real (suscripción *Azure for Students*), pero el valor que
> se registra es un **canario** con formato reconocible (`POC-CANARY-…`), no una credencial real. Es
> el espejo funcional de la PoC pensada para Pacífico.

## Lo que este repo demuestra

Que el secreto llega al Key Vault y **nadie puede verlo por el camino** — ni siquiera el pipeline que
lo creó. La identidad de GitHub tiene un rol a medida con **dos acciones**, `setSecret` y `readMetadata`
(escribe y ve nombres, nunca valores), así que después de escribir, el registro comprueba esto:

```
Creado poc-multikv-std02-token en azkvpoclabeu2d01 (versión 1a5f…).
Azure negó la relectura (403), como corresponde.
```

Ese `403` no es una demo: si algún día alguien le asigna un rol más permisivo a la identidad, ese paso
falla y la corrida queda marcada con una **alerta de permisos**. Es un control permanente.

## Cómo registrar un secreto

Todo ocurre en **un único issue**; nadie usa terminal ni el portal de Azure.

**1. Pedido.** Abrís un issue con la plantilla *registro de secreto*: nombre del secreto, **Key
Vault** (uno o varios, uno por línea) y justificación. **Nunca el valor.**

**2. Validación.** `github[bot]` revisa el pedido (autor habilitado, sin valores pegados, nombre
válido, nomenclatura del KV) y hace un **chequeo previo en Azure** por cada KV: que exista, que el
runner llegue y que el nombre esté libre. Si algo falla, comenta el motivo y el issue queda abierto
para corregirlo editando.

**3. El valor.** Con la validación en verde, quien recibió el valor lo carga **una sola vez** como
**secret de GitHub** con el nombre que indica el bot (`VALOR_ISSUE_<n>`) y comenta `/cargado`.

**4. Aprobación.** Recién ahí nace la corrida que espera la aprobación. Un analista de Seguridad
aprueba en el environment (`registro-secretos`, o `registro-secretos-prod` si es producción). Antes de
escribir, el workflow relee el issue y aborta si cambió desde que se validó.

**5. Escritura atómica.** `github[bot]` escribe el mismo valor en **todos los KV** de la lista, con una
garantía de transacción: **pre-chequea todos antes de escribir; si uno solo falla, no escribe en
ninguno**. En cada KV comprueba que no puede releer el secreto (el `403`).

**6. Limpieza y cierre.** Salga como salga, borra el secret de GitHub `VALOR_ISSUE_<n>` con una
**GitHub App** y cierra el issue con una **tabla por KV** y el label del desenlace.

Dos controles corren solos: un **barrido** cada hora borra secrets de GitHub sueltos y cancela esperas
de más de 24 h, y una **conciliación** diaria compara los KV contra los pedidos registrados (solo
nombres y etiquetas) y avisa si aparece un secreto sin pedido detrás.

### Un secreto en varios KV

El campo Key Vault admite **varios KV, uno por línea, todos del mismo ambiente** (misma letra `d`/`c`/`p`):
un mismo valor se registra en todos bajo **una sola aprobación**. Si la lista mezcla ambientes, el
pedido se rechaza (cruzar cert/prod son pedidos separados). La escritura es atómica: nada queda a
medias.

## Montar el entorno

Todo lo de Azure está en [`infra/bootstrap.sh`](infra/bootstrap.sh), idempotente:

```bash
az login
bash infra/bootstrap.sh
```

Crea el grupo de recursos, las **dos identidades** (registro y conciliación) con sus credenciales
federadas, los **dos roles a medida** y sus asignaciones, y las bóvedas de prueba con la nomenclatura
de la empresa (`azkvpoclabeu2d01`/`d04` escritura normal, `d02` sin rol de escritura, `d03` lectura de
más, `p01` producción). Al terminar imprime los identificadores para GitHub.

Del lado de GitHub hace falta:

| Qué | Dónde |
|---|---|
| **4 environments:** `registro-secretos` y `registro-secretos-prod` (con revisor de Seguridad), `conciliacion` (sin revisores), `github-app` (sin revisores) | Settings › Environments |
| Secrets de Azure (`AZURE_CLIENT_ID`/`TENANT_ID`/`SUBSCRIPTION_ID`) en los environments que entran a Azure | Environment secrets (repo público) |
| Llave privada de la **GitHub App** como secret del environment `github-app`; su `APP_CLIENT_ID` como variable | Settings › Environments › `github-app` |
| Variables `ALLOWED_REQUESTERS`, `SECURITY_TEAM`, `FLOW_START` | Settings › Variables |
| Labels: `registro-secreto`, `con-errores`, `registrado`, `rechazado`, `fallido`, `alerta-permisos`, `alerta-parcial`, `alerta-conciliacion` | Issues › Labels |

Son **cuatro environments porque son cuatro puertas**: registro (escribe, espera aprobación),
producción (escribe, aprobación estricta), conciliación (solo lista nombres, corre sola) y la App
(guarda su llave). Los datos de Azure son **identificadores, no credenciales**: sin un token firmado
por GitHub para este repo y environment no abren nada. En repo público van como secrets del environment
para que no queden en claro en los logs.

## Estado

| Pieza | Estado |
|---|---|
| Login OIDC sin secretos guardados | funciona |
| Registro real en Key Vault | funciona |
| El pipeline no puede releer lo que escribe | verificado (`403`) |
| Un valor en **varios KV**, escritura **atómica** | verificado (STD-02/03) |
| El valor no aparece en logs ni en el issue | verificado, 0 apariciones |
| Pausa para que Seguridad apruebe | funciona (repo público; en privado requiere Enterprise) |
| Borrado del secret de GitHub con la App + barrido | funciona |
| Conciliación de la bóveda (consciente de la lista) | funciona |

## Límites

- **Un solo carril:** siempre hay una persona que carga el valor y lo conoce. El flujo no genera
  valores; su alcance es el **registro**, no la generación.
- **Un secreto en varios KV** solo si son del **mismo ambiente** (misma letra). Cruzar ambientes son
  pedidos separados.
- La **atomicidad** es por pre-chequeo, no por rollback: una carrera rarísima entre el pre-chequeo y la
  escritura puede dejar un estado parcial, que se marca con alerta para revisión manual.
- Las bóvedas se validan por su **nomenclatura** `azkv<código>eu2<d|c|p><nn>`; el ambiente sale de la
  letra. El formulario no las lista.
- **Sin fecha de vencimiento**, siguiendo la práctica actual de la compañía. Activarlo es una línea
  (`--expires`) el día que exista una política de rotación.
- Que las aplicaciones **lean** el secreto es otra fase.
