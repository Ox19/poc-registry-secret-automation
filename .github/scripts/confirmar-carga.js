// Cuenta en el issue si el secret de GitHub del pedido está cargado. Si lo está, esta misma corrida queda
// esperando la aprobación del analista: por eso el link apunta a ella.
'use strict';

const { githubSecretName, runUrl, mentions, updateStages } = require('./common');

const TTL_HOURS = 24;
const toUtc = (date) => date.toISOString().replace('T', ' ').slice(0, 16);

module.exports = async ({ github, context, core }) => {
    const { FOUND, UPDATED_AT } = process.env;
    const valueName = githubSecretName(context.issue.number);
    core.setOutput('ok', 'false');

    if (FOUND !== 'true') {
        await updateStages(github, context, { valor: ['### ❌ No encuentro el valor', '',
            `No existe el secret de GitHub \`${valueName}\`. Revisá el nombre exacto y volvé a comentar \`/cargado\`.`].join('\n') });
        return;
    }

    const loaded = new Date(UPDATED_AT);
    const expires = new Date(loaded.getTime() + TTL_HOURS * 3600 * 1000);
    await updateStages(github, context, { valor: ['### ✅ Valor cargado, esperando aprobación', '',
        `El secret de GitHub \`${valueName}\` existe (cargado el ${toUtc(loaded)} UTC).`,
        `Vence el ${toUtc(expires)} UTC: si no se aprueba antes, se borra y hay que volver a cargarlo.`, '',
        `${mentions(process.env.SECURITY_TEAM)} aprobá o rechazá en **[Review deployments](${runUrl(context)})**.`].join('\n') });
    core.setOutput('ok', 'true');
};
