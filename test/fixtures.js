// Fixtures reproducing the real CGD header formats (card = latin1 + CRLF,
// current account = UTF-8 with BOM + LF).
export const cardCsv = (mmYYYY) => Buffer.from(
  `Consultar saldos e movimentos de cartões - 10-10-2026\r\nNome empresa ;NITIDA - CONSULTORIA INFORMATICA,LDA\r\nNIF ;513889493\r\n\r\n` +
  `Conta cartão ;10104547020 - EUR - Business Classic\r\nTipo de movimentos ;Contabilizados\r\nExtrato ;${mmYYYY} \r\n\r\n` +
  `Data ;Data valor ;Descrição ;Débito ;Crédito ;\r\n03-10-2026 ;03-10-2026 ;ANUIDADE CARTAO ;45,00 ;;\r\n`,
  'latin1'
);

export const ordemCsv = (from, to) => Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from(
    `Consultar saldos e movimentos à ordem - 10-10-2026;="0206013058630"\nNome cliente;NITIDA\nNIF;513889493\n\nDados da conta\n` +
    `Saldo disponível;1.840,09 EUR\n\nDados da consulta\nPeríodo;Outro\nIntervalo de;${from} a ${to}\nTipos de movimento;Todos\n\n` +
    `Data mov.;Data-valor;Descrição;Montante;Saldo contabilístico após movimento\n30-09-2026;30-09-2026;SUPERAREOSA SUPERMER;-30,00;883,72\n`,
    'utf8'
  ),
]);
