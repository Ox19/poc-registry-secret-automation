#!/usr/bin/env node
// Genera el valor del secreto en el runner: nadie lo teclea ni lo ve. Sale solo por stdout.
// SOLO PoC: con formato de canario; el generador real lo emite el proveedor por API.
'use strict';

const crypto = require('node:crypto');
const { fail, CANARY_PATTERN } = require('./common');

const value = `POC-CANARY-${crypto.randomBytes(32).toString('hex')}-NO-ES-UN-SECRETO-REAL`;

// Si el formato se desalinea con la batería, falla acá y no a mitad del registro.
if (!CANARY_PATTERN.test(value)) fail('el valor generado no cumple el formato de canario.');

process.stdout.write(value);
