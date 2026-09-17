// Deja constancia en el issue, nunca el valor: resultado, aprobador real y cierre si se registró.
// Lo invoca actions/github-script; la metadata llega por env desde el job de registro.
'use strict';

const { REGISTERED_LABEL, issueRef, runUrl } = require('./common');

module.exports = async ({ github, context }) => {
    const { REGISTER_RESULT, SECRET_NAME, VAULT } = process.env;
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

    await github.rest.issues.createComment({ ...issue, body: [
        '### ✅ Secreto registrado en Azure Key Vault', '',
        '| Campo | Valor |', '|---|---|',
        `| Nombre | \`${SECRET_NAME}\` |`, `| Key Vault | \`${VAULT}\` |`,
        `| Aprobado por | ${approver ? `@${approver}` : 'no identificado'} |`, '',
        `El valor lo generó el sistema y nadie lo vio. Run: ${runUrl(context)}`,
    ].join('\n') });
    await github.rest.issues.addLabels({ ...issue, labels: [REGISTERED_LABEL] });
    await github.rest.issues.update({ ...issue, state: 'closed', state_reason: 'completed' });
};
