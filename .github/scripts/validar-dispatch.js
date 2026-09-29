// Prototipo del punto 1 de la revisión: la solicitud entra por workflow_dispatch con inputs TIPADOS,
// no parseando el body de un issue. El issue se crea al final, solo para AUDITORÍA.
'use strict';

const { SECRET_NAME_PATTERN, SECRET_NAME_MAX, requestEnvironment, LABELS } = require('./common');

module.exports = async ({ github, context, core }) => {
    const { NAME, VAULTS_RAW, DESCRIPTION, JUSTIFICATION, ACTOR } = process.env;

    // Los KV llegan como texto: uno por línea o separados por coma. Todos del mismo ambiente.
    const vaults = [...new Set((VAULTS_RAW || '').split(/[\n,]/).map((v) => v.trim()).filter(Boolean))];
    const { environment, error: vaultError } = requestEnvironment(vaults);

    const errors = [];
    if (!SECRET_NAME_PATTERN.test(NAME || '') || (NAME || '').length > SECRET_NAME_MAX) {
        errors.push(`El nombre del secreto \`${NAME}\` no es válido: minúsculas, números y guiones, hasta ${SECRET_NAME_MAX}.`);
    }
    if (vaultError) errors.push(vaultError);
    if (!DESCRIPTION) errors.push('Falta la descripción.');
    if (!JUSTIFICATION) errors.push('Falta la justificación.');
    if (errors.length) {
        await core.summary.addRaw(['### ❌ Entrada inválida', '', ...errors.map((e) => `- ${e}`)].join('\n')).write();
        return core.setFailed('Entrada inválida (ver el resumen de la corrida).');
    }

    // Issue SOLO para auditoría: qué se pidió, dónde, por qué y quién. No se parsea; es el registro.
    const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
    const body = ['## Solicitud registrada por `workflow_dispatch`', '',
        `- **Nombre del secreto:** \`${NAME}\``,
        `- **Key Vault(s):** ${vaults.map((v) => `\`${v}\``).join(', ')}`,
        `- **Ambiente:** ${environment.label}`,
        `- **Descripción:** ${DESCRIPTION}`,
        `- **Justificación:** ${JUSTIFICATION}`,
        `- **Solicitado por:** @${ACTOR}`,
        `- **Corrida:** ${runUrl}`, '',
        '_Auditoría. El proceso se disparó con inputs tipados; este issue no se parsea, solo deja constancia._'].join('\n');

    const { data: issue } = await github.rest.issues.create({
        owner: context.repo.owner, repo: context.repo.repo,
        title: `[Auditoría] ${NAME}`, body, labels: [LABELS.request],
    });
    core.setOutput('issue', issue.number);
    await core.summary.addRaw(`### ✅ Solicitud válida\n\nAuditoría en #${issue.number} (${environment.label}).`).write();
};
