// Utilidades compartidas por los scripts.
'use strict';

// Formato del valor de prueba: lo genera la PoC y es lo único que acepta la batería de fugas.
const CANARY_PATTERN = /^POC-CANARY-[0-9a-f]+-NO-ES-UN-SECRETO-REAL$/;

// Marca del issue ya registrado: impide generar dos veces para la misma solicitud.
const REGISTERED_LABEL = 'registrado';

const issueRef = ({ repo, issue }) => ({ owner: repo.owner, repo: repo.repo, issue_number: issue.number });
const runUrl = ({ serverUrl, repo, runId }) => `${serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${runId}`;

function fail(message) {
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
}

module.exports = { fail, CANARY_PATTERN, REGISTERED_LABEL, issueRef, runUrl };
