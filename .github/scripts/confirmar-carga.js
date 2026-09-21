// Cuenta en el issue si el secret de GitHub del pedido está cargado y, si lo está, avisa que ya se puede aprobar.
'use strict';

const { githubSecretName, mentions, updateStages } = require('./common');

const TTL_HOURS = 24;

module.exports = async ({ github, context }) => {
    const { FOUND, UPDATED_AT } = process.env;
    const valueName = githubSecretName(context.issue.number);

    if (FOUND !== 'true') {
        await updateStages(github, context, { valor: ['### ❌ No encuentro el valor', '',
            `No existe el secret de GitHub \`${valueName}\`. Revisá el nombre exacto y volvé a comentar \`/cargado\`.`].join('\n') });
        return;
    }

    // La corrida de este pedido que está esperando la aprobación del analista.
    const { data } = await github.rest.actions.listWorkflowRuns({
        owner: context.repo.owner, repo: context.repo.repo, workflow_id: 'registrar-secreto.yml', status: 'waiting' });
    const run = data.workflow_runs.find((candidate) => candidate.display_title === `Registrar — #${context.issue.number}`);
    const expires = new Date(new Date(UPDATED_AT).getTime() + TTL_HOURS * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);

    await updateStages(github, context, { valor: ['### ✅ Valor cargado, listo para aprobar', '',
        `El secret de GitHub \`${valueName}\` existe (cargado el ${UPDATED_AT.replace('T', ' ').slice(0, 16)} UTC).`,
        `Vence el ${expires} UTC: si no se aprueba antes, el barrido lo borra y hay que volver a cargarlo.`, '',
        run ? `${mentions(process.env.SECURITY_TEAM)} aprobá o rechazá en **[Review deployments](${run.html_url})**.`
            : `${mentions(process.env.SECURITY_TEAM)} no encontré la corrida que espera aprobación: revisá la pestaña Actions.`].join('\n') });
};
