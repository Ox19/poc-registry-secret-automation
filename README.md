# Registro de secretos en Azure Key Vault

Registra secretos en Key Vault **sin que ninguna persona teclee, cifre ni vea el valor**: lo genera
el workflow y lo escribe directo en la bóveda con identidad federada.

> **Laboratorio.** Corre contra un Azure real (suscripción *Azure for Students*), pero el valor que
> se registra es un canario con formato reconocible, no una credencial de un sistema real. Es el
> espejo funcional de una PoC hecha para un cliente, donde el registro estaba simulado.

## Lo que este repo demuestra

Que el secreto llega al Key Vault y **nadie puede verlo por el camino** — ni siquiera el propio
pipeline que lo creó. La identidad de GitHub tiene un rol con **una sola acción**, `setSecret`, así
que el último paso del registro es este:

```
Registrado: poc-lab-azure-01 en kv-poc-secretos-78e549, expira 2027-03-09.
Azure denegó la lectura, como corresponde:
ERROR: (Forbidden) Caller is not authorized to perform action on resource.
```

Ese `Forbidden` no es una demo: si algún día alguien le asigna un rol más permisivo a la identidad,
ese step falla y el registro se cae. Es un control permanente.

## Cómo registrar un secreto

**1.** Abrí un issue con la plantilla *Solicitud de registro de secreto*: nombre, Key Vault,
repositorio que lo usa, expiración y justificación. **Nunca el valor.**

**2.** El workflow valida la solicitud. Si algo está mal, comenta el motivo y cierra el issue: para
corregir se abre otro, editar el existente no lo reprocesa.

**3.** Seguridad aprueba en el environment `registro-secretos`. Antes de generar nada, el workflow
verifica que el issue no haya cambiado desde que se validó.

**4.** El sistema genera el valor, lo escribe en el Key Vault con expiración obligatoria, comenta
quién aprobó y cierra el issue con el label `registrado`.

## Montar el entorno

Todo lo de Azure está en [`infra/bootstrap.sh`](infra/bootstrap.sh), que es idempotente y se puede
volver a correr sin romper nada:

```bash
az login
bash infra/bootstrap.sh
```

Crea dos recursos — el Key Vault y una identidad administrada — más la credencial federada, un rol a
medida y sus asignaciones. Al terminar imprime los identificadores que hay que cargar en GitHub.

Del lado de GitHub hace falta:

| Qué | Dónde |
|---|---|
| Secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | Settings › Environments › `registro-secretos` › Environment secrets |
| Labels `registro-secreto` y `registrado` | Issues › Labels |
| Environment `registro-secretos`, limitado a `main` | Settings › Environments |

Los tres valores son **identificadores, no credenciales**: sin un token firmado por GitHub para este
repo y este environment, no abren nada. Van como secrets del environment por dos razones concretas:
este repo es **público**, así que de otro modo quedarían en claro en los logs, y atados al environment
solo los ve el job que ya pasó por la aprobación. En un repo privado corresponden **variables de
environment**, que se leen igual pero son visibles para diagnosticar.

## Estado

| Pieza | Estado |
|---|---|
| Login OIDC sin secretos guardados | funciona |
| Registro real en Key Vault con expiración | funciona |
| El pipeline no puede releer lo que escribe | verificado (`Forbidden`) |
| El valor no aparece en logs ni en el issue | verificado, 0 apariciones |
| **Pausa para que Seguridad apruebe** | **pendiente** — los revisores obligatorios en repo privado requieren GitHub Pro |

Mientras no esté esa pausa, el job de registro corre sin detenerse. El environment igual cumple su
otra función: el token OIDC solo se emite a un job que lo declare.

## Límites

- Solo secretos que un sistema puede generar por API. Los que entrega una persona o un proveedor sin
  API quedan fuera de alcance.
- Los Key Vault autorizados son una lista dentro de `.github/scripts/validar-solicitud.js`. El
  formulario no los muestra: si se pide uno que no está, la solicitud se rechaza indicando el motivo.
  Esa lista es el control real, porque el issue se puede editar después de abrirlo.
- El ambiente no se pide: se desprende del nombre del Key Vault.
- El alcance es el **registro**. Que las aplicaciones lean el secreto es otra fase.
