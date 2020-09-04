export const QUOTE_REQUEST_BODY = {
  depositMethod: 'btc',
  settleMethod: 'ltc',
  depositAmount: '0.0015'
}

export const QUOTE_REQUEST_RESPONSE = {
  createdAt: '2020-09-04T07:25:52.6752',
  depositAmount: '0.0015',
  depositMethod: 'btc',
  expiresAt: '2020-09-04T07:40:52.6752',
  id: '12dc0782-f19f-4abb-8b2b-87aa7d6fd77b',
  rate: '188.317',
  settleAmount: '0.2894532784',
  settleMethod: 'ltc'
}

export const ORDER_REQUEST_BODY = {
  type: 'fixed',
  quoteId: '12dc0782-f19f-4abb-8b2b-87aa7d6fd77b',
  affiliateId: 'FyacsJHluwd',
  sessionSecret: 'siujdhfuijsdhgiuyw897813i4',
  settleAddress:
    'fe2ed5a8a652488b33321a5222c80b6ad981ff2433cc86dc5c319bad1b0d0c70'
}

export const ORDER_REQUEST_RESPONSE = {
  createdAt: '1599201558372',
  createdAtISO: '2020-09-04T07:27:52.6752',
  expiresAt: '1599201578372',
  expiresAtIso: '2020-09-04T07:27:52.6752',
  depositAddress: {
    address: '1F1tAaz5x1HUXrCNLbtMDqcw6o5GNn4xqX'
  },
  depositMethod: 'btc',
  id: 'a67a90b58a6782f7834f',
  orderId: 'a67a90b58a6782f7834f',
  settleAddress: {
    address: 'fe2ed5a8a652488b33321a5222c80b6ad981ff2433cc86dc5c319bad1b0d0c70'
  },
  settleMethod: 'ltc',
  depositMax: '0.0015',
  depositMin: '0.0015',
  quoteId: '12dc0782-f19f-4abb-8b2b-87aa7d6fd77b',
  settleAmount: '0.23647895',
  depositAmount: '0.0015',
  deposits: []
}
