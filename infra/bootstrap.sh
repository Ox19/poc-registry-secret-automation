#!/usr/bin/env bash
# Crea en Azure lo que la PoC necesita: la bóveda, la identidad federada de GitHub y un permiso
# de solo escritura. Es idempotente: volver a correrlo no rompe ni duplica nada.
set -euo pipefail

# Lo único que se cambia para replicar el lab en otra suscripción.
LOCATION="eastus"
RESOURCE_GROUP="rg-poc-secretos"
VAULT_NAME="kv-poc-secretos-78e549"          # 3-24 caracteres, único en todo Azure
IDENTITY_NAME="id-github-registro-secretos"
GITHUB_REPO="Ox19/registry-secret-automation"
GITHUB_ENVIRONMENT="registro-secretos"
WRITER_ROLE_NAME="Key Vault Secret Writer (PoC)"

SUBSCRIPTION_ID="$(az account show --query id --output tsv)"
CURRENT_USER_ID="$(az ad signed-in-user show --query id --output tsv)"

echo "==> 1/7 Grupo de recursos"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

echo "==> 2/7 Key Vault con RBAC"
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

echo "==> 3/7 Identidad administrada para GitHub"
# Es un recurso de la suscripción, no un App Registration: no necesita permisos en el Entra de la U.
az identity create --name "$IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --output none
IDENTITY_PRINCIPAL_ID="$(az identity show --name "$IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --query principalId --output tsv)"
IDENTITY_CLIENT_ID="$(az identity show --name "$IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --query clientId --output tsv)"

echo "==> 4/7 Credencial federada: solo este repo y solo este environment"
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

echo "==> 5/7 Rol a medida: escribir sí, leer no"
# El rol integrado 'Key Vault Secrets Officer' también permite getSecret, así que el pipeline
# podría releer lo que acaba de escribir. Este rol tiene una sola acción y cierra ese hueco.
if [[ -z "$(az role definition list --name "$WRITER_ROLE_NAME" --query "[].name" --output tsv)" ]]; then
    az role definition create --role-definition "{
        \"Name\": \"$WRITER_ROLE_NAME\",
        \"Description\": \"Escribe secretos en Key Vault sin poder leerlos.\",
        \"Actions\": [],
        \"DataActions\": [\"Microsoft.KeyVault/vaults/secrets/setSecret/action\"],
        \"AssignableScopes\": [\"/subscriptions/$SUBSCRIPTION_ID\"]
    }" --output none
fi

echo "==> 6/7 Asignar ese rol a la identidad, solo sobre esta bóveda"
az role assignment create \
    --assignee-object-id "$IDENTITY_PRINCIPAL_ID" \
    --assignee-principal-type ServicePrincipal \
    --role "$WRITER_ROLE_NAME" \
    --scope "$VAULT_ID" \
    --output none

echo "==> 7/7 Darme a mí lectura, para poder verificar el resultado"
az role assignment create \
    --assignee-object-id "$CURRENT_USER_ID" \
    --assignee-principal-type User \
    --role "Key Vault Secrets Officer" \
    --scope "$VAULT_ID" \
    --output none

cat <<RESUMEN

Listo. Cargar estos valores como variables del repo en GitHub:

  AZURE_CLIENT_ID        $IDENTITY_CLIENT_ID
  AZURE_TENANT_ID        $(az account show --query tenantId --output tsv)
  AZURE_SUBSCRIPTION_ID  $SUBSCRIPTION_ID
  KEY_VAULT_NAME         $VAULT_NAME

No son secretos: son identificadores. Sin el token firmado por GitHub no sirven para entrar.
RESUMEN
