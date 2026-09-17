# Registro de secretos en Azure Key Vault

El valor va **directo de su origen a la bóveda, en un solo salto**, y quien lo pone no puede leerlo
después. Si el secreto lo puede emitir una API, lo escribe `github[bot]` y nadie lo ve nunca; si lo
entrega un proveedor, lo carga quien lo recibió — sin pasar por chat, correo ni por este repo.

> **Laboratorio.** Corre contra un Azure real (suscripción *Azure for Students*), pero el valor que
> se registra es un canario con formato reconocible, no una credencial de un sistema real. Es el
> espejo funcional de una PoC hecha para un cliente, donde el registro estaba simulado.

## Lo que este repo demuestra

Que el secreto llega al Key Vault y **nadie puede verlo por el camino** — ni siquiera el propio
pipeline que lo creó. La identidad de GitHub tiene un rol con **una sola acción**, `setSecret`, así
que el último paso del registro es este:

```
Registrado: ms-cobranzas-sonarqube-token en kv-poc-secretos-78e549.
Azure denegó la lectura, como corresponde:
ERROR: (Forbidden) Caller is not authorized to perform action on resource.
```

Ese `Forbidden` no es una demo: si algún día alguien le asigna un rol más permisivo a la identidad,
ese step falla y el registro se cae. Es un control permanente.

## Cómo registrar un secreto

**1.** Abrí un issue con la plantilla *Solicitud de registro de secreto*: nombre, Key Vault, **de
dónde viene el valor** y para qué lo necesita. **Nunca el valor.**

**2.** El workflow valida la solicitud. Si algo está mal, comenta el motivo y cierra el issue: para
corregir se abre otro, editar el existente no lo reprocesa.

**3.** Seguridad aprueba en el environment `registro-secretos`. Antes de generar nada, el workflow
verifica que el issue no haya cambiado desde que se validó.

**4.** Según lo declarado en el paso 1:

- **Lo genera un sistema** → `github[bot]` lo escribe en el Key Vault, comenta quién aprobó y cierra
  el issue con el label `registrado`. Nadie ve el valor.
- **Lo entrega un proveedor** → el workflow no lo pide ni lo recibe: comenta que ya está aprobado,
  pone el label `pendiente-carga` y deja el issue abierto. Quien tiene el valor lo carga en el portal
  con el permiso de solo escritura.

**5.** El workflow de conciliación compara la bóveda contra los pedidos aprobados: cierra los que ya
se cargaron y **avisa si aparece un secreto sin pedido detrás**.

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
| Secrets de Azure en **dos** environments: `registro-secretos` y `conciliacion` | Settings › Environments › Environment secrets |
| Labels `registro-secreto`, `registrado` y `pendiente-carga` | Issues › Labels |
| Environment `registro-secretos` **con revisor obligatorio**, limitado a `main` | Settings › Environments |
| Environment `conciliacion` **sin revisores**, limitado a `main` | Settings › Environments |

Son dos environments porque son dos identidades con permisos distintos: la de registro **escribe** y
espera aprobación; la de conciliación **solo lista nombres** y corre sola. Si compartieran identidad,
la conciliación podría escribir sin que nadie apruebe.

Los tres valores son **identificadores, no credenciales**: sin un token firmado por GitHub para este
repo y este environment, no abren nada. Van como secrets del environment por dos razones concretas:
este repo es **público**, así que de otro modo quedarían en claro en los logs, y atados al environment
solo los ve el job que ya pasó por la aprobación. En un repo privado corresponden **variables de
environment**, que se leen igual pero son visibles para diagnosticar.

## Estado

| Pieza | Estado |
|---|---|
| Login OIDC sin secretos guardados | funciona |
| Registro real en Key Vault | funciona |
| El pipeline no puede releer lo que escribe | verificado (`Forbidden`) |
| El valor no aparece en logs ni en el issue | verificado, 0 apariciones |
| Pausa para que Seguridad apruebe | funciona (el repo es público: en privado requiere Enterprise) |
| Bifurcación según el origen del valor | funciona |
| Conciliación de la bóveda | funciona |
| Carga a mano por un grupo de custodios | **pendiente** — el tenant de la universidad no permite crear grupos |

## Límites

- Solo secretos que un sistema puede generar por API. Los que entrega una persona o un proveedor sin
  API quedan fuera de alcance.
- Cuando el valor lo carga una persona, la aprobación **no se puede forzar técnicamente**: se detecta
  después, con la conciliación. Cuando lo escribe `github[bot]`, sí es imposible de saltear.
- Los Key Vault autorizados son una lista dentro de `.github/scripts/validar-solicitud.js`. El
  formulario no los muestra: si se pide uno que no está, la solicitud se rechaza indicando el motivo.
  Esa lista es el control real, porque el issue se puede editar después de abrirlo.
- El ambiente no se pide: se desprende del nombre del Key Vault.
- **Los secretos se registran sin fecha de vencimiento**, siguiendo la práctica actual de la
  compañía. Es una decisión tomada, no un olvido: el flujo soporta ponerla con una línea
  (`--expires`), y conviene revisarla cuando se defina una política de rotación.
- El alcance es el **registro**. Que las aplicaciones lean el secreto es otra fase.
