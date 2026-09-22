// Cierra el pedido con su desenlace y una tabla por KV. Nunca muestra el valor.
// Lo invoca actions/github-script; la metadata llega por env desde los jobs previos.
'use strict';

const { LABELS, githubSecretName, issueRef, repoUrl, runUrl, mentions, readRequest, updateStages } = require('./common');

const FAILURE_REASONS = {
    'sin-valor': 'el secret de GitHub no estaba cargado o venció',
    'nombre-existe': 'ya existe un secreto con ese nombre en el KV',
    'red-cerrada': 'el KV tiene la red cerrada y el runner no llega; lo resuelve Cloud',
    'sin-rol': 'la identidad del pipeline no tiene rol de escritura en este KV; pedido a Cloud',
    'access-policy': 'el KV usa Access Policies y el permiso del pipeline no aplica; Cloud lo da en este KV o lo migra a RBAC',
    'en-papelera': 'hay un secreto con ese nombre en la papelera del KV; elegí otro nombre del secreto',
    'pedido-cambiado': 'el issue cambió después de validarse',
    'pedido-cerrado': 'el issue se cerró mientras esperaba',
    'ya-registrado': 'el pedido ya estaba registrado',
    otro: 'Azure respondió un error inesperado (ver el log de la corrida)',
};

// Link para volver a pedir con un clic: mismo formulario, mismos datos, a nombre de quien hace clic.
// vaults = los KV a reintentar (todos, o solo los que faltan en un estado parcial). La textarea del
// formulario los recibe multilínea (URLSearchParams codifica el salto de línea como %0A).
function reopenLink(context, request, vaults) {
    const params = new URLSearchParams({
        template: 'registro-secreto.yml',
        title: `[Secreto] ${request.name}`,
        name: request.name,
        vault: vaults.join('\n'),
        justification: `Reemplaza a #${context.issue.number}. ${request.justification}`,
    });
    return `${repoUrl(context)}/issues/new?${params}`;
}

// Una fila por KV, según lo que hizo la escritura.
function kvTable(rows) {
    return ['| KV | Resultado | Detalle |', '|---|---|---|', ...rows.map((row) => {
        if (row.status === 'registrado') {
            return row.alert === 'true'
                ? `| \`${row.vault}\` | 🚨 registrado, se pudo leer | versión \`${row.version}\`; la identidad tuvo más permiso del debido |`
                : `| \`${row.vault}\` | ✅ registrado | versión \`${row.version}\`; Azure negó la relectura (403), como corresponde |`;
        }
        if (row.status === 'fallido') return `| \`${row.vault}\` | ⚠️ falló | ${FAILURE_REASONS[row.reason] || FAILURE_REASONS.otro} |`;
        return `| \`${row.vault}\` | ⛔ no escrito | ${row.reason ? (FAILURE_REASONS[row.reason] || row.reason) : 'la transacción se abortó antes de escribir'} |`;
    })].join('\n');
}

module.exports = async ({ github, context }) => {
    const { REASON, PHASE, RESULTS, DELETED } = process.env;
    const results = JSON.parse(RESULTS || '[]');
    const ref = issueRef(context);
    const { data: issue } = await github.rest.issues.get(ref);
    const request = readRequest(issue.body || '');
    const { data: reviews } = await github.rest.actions.getReviewsForRun({ owner: ref.owner, repo: ref.repo, run_id: context.runId });
    const rejected = reviews.find((review) => review.state === 'rejected');
    const approver = reviews.find((review) => review.state === 'approved')?.user.login;

    const valueName = githubSecretName(context.issue.number);
    const cleanup = DELETED === 'true'
        ? `🧹 Secret de GitHub \`${valueName}\` borrado.`
        : `⚠️ No se pudo confirmar el borrado del secret de GitHub \`${valueName}\`: lo reintenta el barrido.`;

    let stage, labels, close;
    if (rejected) {
        stage = ['### ❌ Rechazado', '', `Rechazado por @${rejected.user.login}${rejected.comment ? `: ${rejected.comment}` : '.'}`];
        labels = [LABELS.rejected];
        close = 'not_planned';
    } else if (PHASE === 'done') {
        const anyAlert = results.some((row) => row.alert === 'true');
        stage = anyAlert
            ? ['### 🚨 Registrado, con alerta de permisos', '',
                `El secreto \`${request.name}\` se registró en ${results.length} KV, aprobado por @${approver}.`,
                '**En al menos un KV la identidad pudo leerlo**: tiene más permiso del debido y hay que corregirlo.', '',
                kvTable(results), '', mentions(process.env.SECURITY_TEAM)]
            : ['### ✅ Registrado', '',
                `El secreto \`${request.name}\` se registró en ${results.length} KV, aprobado por @${approver}. La identidad intentó releer cada uno y Azure se lo negó (403).`, '',
                kvTable(results)];
        labels = anyAlert ? [LABELS.registered, LABELS.permissionAlert] : [LABELS.registered];
        close = 'completed';
    } else if (PHASE === 'partial') {
        const failed = results.filter((row) => row.status !== 'registrado').map((row) => row.vault);
        stage = ['### ⚠️ Estado parcial: requiere revisión manual', '',
            'Se escribió en algunos KV pero **falló en otro después de pasar el pre-chequeo** (una carrera rara). Los ya escritos quedan; el resto hay que resolverlo a mano.', '',
            kvTable(results), '',
            `Para reintentar solo lo que falta: **[Abrir el pedido de nuevo](${reopenLink(context, request, failed)})**`, '',
            mentions(process.env.SECURITY_TEAM)];
        labels = [LABELS.failed, LABELS.partialAlert];
        close = 'not_planned';
    } else if (PHASE === 'aborted') {
        const detail = results.length ? ['', kvTable(results), ''] : ['', `Motivo: ${FAILURE_REASONS[REASON] || FAILURE_REASONS.otro}.`, ''];
        stage = ['### ⚠️ No se registró: transacción abortada', '',
            '**Ningún KV fue modificado**: el pre-chequeo falló en al menos uno, así que no se escribió en ninguno.',
            ...detail,
            `Para volver a pedirlo: **[Abrir el pedido de nuevo](${reopenLink(context, request, request.vaults)})**`];
        labels = [LABELS.failed];
        close = 'not_planned';
    } else {
        stage = ['### ⚠️ Falló la escritura', '',
            `No se registró el secreto: ${FAILURE_REASONS[REASON] || FAILURE_REASONS.otro}.`, '',
            `Para volver a pedirlo: **[Abrir el pedido de nuevo](${reopenLink(context, request, request.vaults)})**`];
        labels = [LABELS.failed];
        close = 'not_planned';
    }

    await updateStages(github, context, {
        resultado: [...stage, '', `Corrida: ${runUrl(context)}`].join('\n'),
        limpieza: cleanup,
    });
    await github.rest.issues.addLabels({ ...ref, labels });
    await github.rest.issues.update({ ...ref, state: 'closed', state_reason: close });
};
