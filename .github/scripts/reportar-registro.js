// Deja constancia en el issue, nunca el valor: resultado, aprobador real y cierre si corresponde.
// Lo invoca actions/github-script; la metadata llega por env desde el job de registro.
'use strict';

const { REGISTERED_LABEL, PENDING_LABEL, issueRef, runUrl } = require('./common');

module.exports = async ({ github, context }) => {
    const { REGISTER_RESULT, SECRET_NAME, VAULT, GENERATED } = process.env;
    const issue = issueRef(context);

    if (REGISTER_RESULT !== 'success') {
        await github.rest.issues.createComment({ ...issue,
            body: `### ⚠️ No se registró\n\nEl registro terminó en \`${REGISTER_RESULT}\`. Detalle: ${runUrl(context)}` });
        return;
    }

    // github.actor es quien abrió el issue: el aprobador sale de la revisión del environment.
    const { data: reviews } = await github.rest.actions.getReviewsForRun({
        owner: issue.owner, repo: issue.repo, run_id: context.runId });
    const approver = reviews.find((review) => review.state === 'approved')?.user.login;

    const tabla = ['| Campo | Valor |', '|---|---|',
        `| Nombre | \`${SECRET_NAME}\` |`, `| Key Vault | \`${VAULT}\` |`,
        `| Aprobado por | ${approver ? `@${approver}` : 'no identificado'} |`, ''];

    // El valor lo entrega un proveedor: está aprobado, pero el secreto todavía no existe.
    if (GENERATED !== 'true') {
        await github.rest.issues.createComment({ ...issue, body: [
            '### 🔓 Aprobado · falta que lo cargues', '', ...tabla,
            `@${context.payload.issue.user.login}, ya podés cargar el valor en el Key Vault.`, '',
            'Cargalo **directo desde el portal de Azure**, con el permiso de solo escritura: no lo pegues',
            'acá ni lo mandes por chat. Cuando el secreto aparezca en la bóveda, este pedido se cierra solo.',
            '', `Run: ${runUrl(context)}`,
        ].join('\n') });
        await github.rest.issues.addLabels({ ...issue, labels: [PENDING_LABEL] });
        return;
    }

    await github.rest.issues.createComment({ ...issue, body: [
        '### ✅ Secreto registrado en Azure Key Vault', '', ...tabla,
        `El valor lo generó el sistema y nadie lo vio. Run: ${runUrl(context)}`,
    ].join('\n') });
    await github.rest.issues.addLabels({ ...issue, labels: [REGISTERED_LABEL] });
    await github.rest.issues.update({ ...issue, state: 'closed', state_reason: 'completed' });
};
