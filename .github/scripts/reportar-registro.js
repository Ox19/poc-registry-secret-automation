// Cierra el pedido con uno de los 4 desenlaces: registrado, rechazado, fallido o alerta de permisos.
// Nunca muestra el valor. Lo invoca actions/github-script; la metadata llega por env desde los jobs previos.
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
};

// Link para volver a pedir con un clic: mismo formulario, mismos datos, a nombre de quien hace clic.
function reopenLink(context, request) {
    const params = new URLSearchParams({
        template: 'registro-secreto.yml',
        title: `[Secreto] ${request.name}`,
        name: request.name,
        vault: request.vault,
        justification: `Reemplaza a #${context.issue.number}. ${request.justification}`,
    });
    return `${repoUrl(context)}/issues/new?${params}`;
}

module.exports = async ({ github, context }) => {
    const { REGISTER_RESULT, REASON, VERSION, ALERT, DELETED } = process.env;
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
    } else if (REGISTER_RESULT === 'success' && ALERT === 'true') {
        stage = ['### 🚨 Registrado, con alerta de permisos', '',
            `El secreto \`${request.name}\` se creó bien en el KV \`${request.vault}\` (versión \`${VERSION}\`), aprobado por @${approver}.`,
            '**Pero la identidad del pipeline pudo leerlo**: tiene más permiso del debido y hay que corregirlo.',
            `${mentions(process.env.SECURITY_TEAM)}`];
        labels = [LABELS.registered, LABELS.permissionAlert];
        close = 'completed';
    } else if (REGISTER_RESULT === 'success') {
        stage = ['### ✅ Registrado', '',
            `Se creó el secreto \`${request.name}\` en el KV \`${request.vault}\` (versión \`${VERSION}\`), aprobado por @${approver}.`,
            'La identidad del pipeline intentó leerlo y Azure se lo negó (403), como corresponde.'];
        labels = [LABELS.registered];
        close = 'completed';
    } else {
        stage = ['### ⚠️ Falló la escritura', '',
            `No se creó el secreto del KV: ${FAILURE_REASONS[REASON] || 'error inesperado, ver el log de la corrida'}.`, '',
            `Este pedido queda cerrado como historia. Para volver a pedirlo: **[Abrir el pedido de nuevo](${reopenLink(context, request)})**`,
            '(el formulario se abre con los mismos datos; se usa otro secret de GitHub, con el número nuevo).'];
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
