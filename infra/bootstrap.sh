#!/usr/bin/env bash
# Crea en Azure lo que la PoC necesita: la bóveda, la identidad federada de GitHub y un permiso
# de solo escritura. Es idempotente: volver a correrlo no rompe ni duplica nada.
set -euo pipefail

# Lo único que se cambia para replicar el lab en otra suscripción.
LOCATION="eastus"
RESOURCE_GROUP="rg-poc-secretos"
VAULT_NAME="kv-poc-secretos-78e549"          # 3-24 caracteres, único en todo Azure
IDENTITY_NAME="id-github-registro-secretos"
GITHUB_REPO="Ox19/poc-registry-secret-automation"
GITHUB_ENVIRONMENT="registro-secretos"
GITHUB_PROD_ENVIRONMENT="registro-secretos-prod"
WRITER_ROLE_NAME="Key Vault Secret Writer (PoC)"
READER_ROLE_NAME="Key Vault Metadata Reader (PoC)"
AUDIT_IDENTITY_NAME="id-github-conciliacion"
AUDIT_ENVIRONMENT="conciliacion"
# Bóvedas con la nomenclatura de la empresa, azkv<código>eu2<d|c|p><nn>: de la letra sale el ambiente.
NAMED_LOCATION="eastus2"
VAULT_DEV="azkvpoclabeu2d01"
VAULT_PROD="azkvpoclabeu2p01"
VAULT_NO_WRITER="azkvpoclabeu2d02"    # prueba de falla: el pipeline no tiene rol de escritura
VAULT_OVER_GRANTED="azkvpoclabeu2d03" # prueba de alerta: el pipeline puede leer, a propósito
VAULT_DEV_2="azkvpoclabeu2d04"        # segundo KV de dev limpio: prueba de un mismo valor en varios KV

SUBSCRIPTION_ID="$(az account show --query id --output tsv)"
CURRENT_USER_ID="$(az ad signed-in-user show --query id --output tsv)"

echo "==> 1/8 Grupo de recursos"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

echo "==> 2/8 Key Vault con RBAC"
# El flag de purge protection se omite a propósito: Azure solo acepta activarlo, nunca ponerlo
# en false, y activarlo es irreversible. Sin él, el lab se puede borrar y recrear.
if ! az keyvault show --name "$VAULT_NAME" --output none 2>/dev/null; then
    az keyvault create \
        --name "$VAULT_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --location "$LOCATION" \
        --enable-rbac-authorization true \
        --retention-days 7 \
        --output none
fi
VAULT_ID="$(az keyvault show --name "$VAULT_NAME" --query id --output tsv)"

echo "==> 3/8 Identidad administrada para GitHub"
# Es un recurso de la suscripción, no un App Registration: no necesita permisos en el Entra de la U.
az identity create --name "$IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --output none
IDENTITY_PRINCIPAL_ID="$(az identity show --name "$IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --query principalId --output tsv)"
IDENTITY_CLIENT_ID="$(az identity show --name "$IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --query clientId --output tsv)"

echo "==> 4/8 Credencial federada: solo este repo y solo este environment"
# El 'subject' es lo que GitHub firma en su token; si no calza exacto, Azure rechaza el login.
# GitHub le anexa los IDs numéricos del dueño y del repo, así que se leen de su API en vez de
# escribirlos a mano: atado al ID, el permiso sobrevive a un renombre y nadie hereda el nombre viejo.
GITHUB_SUBJECT="$(gh api "repos/$GITHUB_REPO" --jq "\"repo:\(.owner.login)@\(.owner.id)/\(.name)@\(.id):environment:$GITHUB_ENVIRONMENT\"")"
az identity federated-credential create \
    --name "github-$GITHUB_ENVIRONMENT" \
    --identity-name "$IDENTITY_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --issuer "https://token.actions.githubusercontent.com" \
    --subject "$GITHUB_SUBJECT" \
    --audiences "api://AzureADTokenExchange" \
    --output none

echo "==> 5/8 Rol a medida: escribir sí, leer no"
# El rol integrado 'Key Vault Secrets Officer' también permite getSecret, así que el pipeline
# podría releer lo que acaba de escribir. Este rol tiene dos acciones y ninguna más:
# readMetadata ve nombres, nunca valores: sirve para rechazar un nombre del secreto que ya existe,
# porque Key Vault no avisa y crearía una versión nueva encima del valor en uso.
writer_body='"description": "Escribe secretos en Key Vault y ve sus nombres, sin poder leer valores.",
    "actions": [],
    "dataActions": ["Microsoft.KeyVault/vaults/secrets/setSecret/action",
                    "Microsoft.KeyVault/vaults/secrets/readMetadata/action"],
    "assignableScopes": ["/subscriptions/'"$SUBSCRIPTION_ID"'"]'

ROLE_ID="$(az role definition list --name "$WRITER_ROLE_NAME" --query "[0].name" --output tsv)"
if [[ -z "$ROLE_ID" ]]; then
    az role definition create --role-definition "{\"Name\": \"$WRITER_ROLE_NAME\", $writer_body}" --output none
else
    az role definition update --role-definition "{\"name\": \"$ROLE_ID\", \"roleName\": \"$WRITER_ROLE_NAME\", $writer_body}" --output none
fi

echo "==> 5b/8 Identidad que concilia: lista nombres y no escribe nada"
# Corre sin aprobación humana, así que no puede tener permiso de escritura: si lo tuviera, alguien
# podría registrar un secreto por esta vía saltándose la aprobación del environment principal.
reader_body='"description": "Lista los secretos de Key Vault. No puede escribir ni ver valores.",
    "actions": [],
    "dataActions": ["Microsoft.KeyVault/vaults/secrets/readMetadata/action"],
    "assignableScopes": ["/subscriptions/'"$SUBSCRIPTION_ID"'"]'

READER_ID="$(az role definition list --name "$READER_ROLE_NAME" --query "[0].name" --output tsv)"
if [[ -z "$READER_ID" ]]; then
    az role definition create --role-definition "{\"Name\": \"$READER_ROLE_NAME\", $reader_body}" --output none
else
    az role definition update --role-definition "{\"name\": \"$READER_ID\", \"roleName\": \"$READER_ROLE_NAME\", $reader_body}" --output none
fi

az identity create --name "$AUDIT_IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --output none
AUDIT_PRINCIPAL_ID="$(az identity show --name "$AUDIT_IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --query principalId --output tsv)"
AUDIT_CLIENT_ID="$(az identity show --name "$AUDIT_IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --query clientId --output tsv)"
AUDIT_SUBJECT="$(gh api "repos/$GITHUB_REPO" --jq "\"repo:\(.owner.login)@\(.owner.id)/\(.name)@\(.id):environment:$AUDIT_ENVIRONMENT\"")"
az identity federated-credential create \
    --name "github-$AUDIT_ENVIRONMENT" \
    --identity-name "$AUDIT_IDENTITY_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --issuer "https://token.actions.githubusercontent.com" \
    --subject "$AUDIT_SUBJECT" \
    --audiences "api://AzureADTokenExchange" \
    --output none
az role assignment create \
    --assignee-object-id "$AUDIT_PRINCIPAL_ID" \
    --assignee-principal-type ServicePrincipal \
    --role "$READER_ROLE_NAME" \
    --scope "$VAULT_ID" \
    --output none

echo "==> 6/8 Asignar ese rol a la identidad, solo sobre esta bóveda"
az role assignment create \
    --assignee-object-id "$IDENTITY_PRINCIPAL_ID" \
    --assignee-principal-type ServicePrincipal \
    --role "$WRITER_ROLE_NAME" \
    --scope "$VAULT_ID" \
    --output none

echo "==> 7/8 Darme a mí lectura, para poder verificar el resultado"
az role assignment create \
    --assignee-object-id "$CURRENT_USER_ID" \
    --assignee-principal-type User \
    --role "Key Vault Secrets Officer" \
    --scope "$VAULT_ID" \
    --output none

echo "==> 8/8 Bóvedas con la nomenclatura de la empresa, para las pruebas del flujo"
# Login del environment de producción: la credencial federada va atada al nombre del environment.
PROD_SUBJECT="$(gh api "repos/$GITHUB_REPO" --jq "\"repo:\(.owner.login)@\(.owner.id)/\(.name)@\(.id):environment:$GITHUB_PROD_ENVIRONMENT\"")"
az identity federated-credential create \
    --name "github-$GITHUB_PROD_ENVIRONMENT" \
    --identity-name "$IDENTITY_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --issuer "https://token.actions.githubusercontent.com" \
    --subject "$PROD_SUBJECT" \
    --audiences "api://AzureADTokenExchange" \
    --output none

for vault in "$VAULT_DEV" "$VAULT_DEV_2" "$VAULT_PROD" "$VAULT_NO_WRITER" "$VAULT_OVER_GRANTED"; do
    if ! az keyvault show --name "$vault" --output none 2>/dev/null; then
        az keyvault create \
            --name "$vault" \
            --resource-group "$RESOURCE_GROUP" \
            --location "$NAMED_LOCATION" \
            --enable-rbac-authorization true \
            --retention-days 7 \
            --output none
    fi
    vault_id="$(az keyvault show --name "$vault" --query id --output tsv)"
    # La identidad que concilia y hace el chequeo previo ve nombres en todas.
    az role assignment create --assignee-object-id "$AUDIT_PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
        --role "$READER_ROLE_NAME" --scope "$vault_id" --output none
    # Yo, solo metadatos: alcanza para verificar nombres y etiquetas de lo que escribe el flujo.
    az role assignment create --assignee-object-id "$CURRENT_USER_ID" --assignee-principal-type User \
        --role "Key Vault Reader" --scope "$vault_id" --output none
    if [[ "$vault" != "$VAULT_NO_WRITER" ]]; then
        az role assignment create --assignee-object-id "$IDENTITY_PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
            --role "$WRITER_ROLE_NAME" --scope "$vault_id" --output none
    fi
done

# A propósito y solo en esta bóveda: el pipeline también puede leer, para que la prueba del 403 lo delate.
az role assignment create --assignee-object-id "$IDENTITY_PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
    --role "Key Vault Secrets User" --scope "$(az keyvault show --name "$VAULT_OVER_GRANTED" --query id --output tsv)" \
    --output none

# En el tenant de la UPC los alumnos no pueden crear grupos (allowedToCreateSecurityGroups: false),
# así que este paso queda documentado y no se ejecuta. En una organización con permisos sería:
#
#   az ad group create --display-name "custodios-secretos-kv" --mail-nickname "custodios-secretos-kv"
#   az role assignment create \
#       --assignee-object-id "<id del grupo>" --assignee-principal-type Group \
#       --role "$WRITER_ROLE_NAME" --scope "$VAULT_ID"
#
# Quien esté en ese grupo puede cargar valores a mano y NO puede leer ninguno: el mismo permiso
# que la identidad de GitHub. Es lo que hace que el flujo sea uno solo.

cat <<RESUMEN

Listo. Cargar estos valores en GitHub, en Settings > Environments > registro-secretos:

Environment "registro-secretos"  (con aprobación de Seguridad):
  AZURE_CLIENT_ID        $IDENTITY_CLIENT_ID
  AZURE_TENANT_ID        $(az account show --query tenantId --output tsv)
  AZURE_SUBSCRIPTION_ID  $SUBSCRIPTION_ID
  KEY_VAULT_NAME         $VAULT_NAME

Environment "$AUDIT_ENVIRONMENT"  (sin aprobación: solo lista nombres, no escribe):
  AZURE_CLIENT_ID        $AUDIT_CLIENT_ID
  AZURE_TENANT_ID        $(az account show --query tenantId --output tsv)
  AZURE_SUBSCRIPTION_ID  $SUBSCRIPTION_ID

No son credenciales: son identificadores. Sin el token firmado por GitHub no sirven para entrar.
En un repo público van como secrets del environment, para que no queden en claro en los logs.
RESUMEN
