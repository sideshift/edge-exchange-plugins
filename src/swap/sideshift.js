// @flow

import { gt, lt } from 'biggystring'
import {
  SwapAboveLimitError,
  SwapBelowLimitError,
  SwapPermissionError
} from 'edge-core-js'
import { EdgeFetchResponse } from 'edge-core-js/lib/types/types'
import {
  type EdgeCorePluginOptions,
  type EdgeCurrencyWallet,
  type EdgeSpendInfo,
  type EdgeSwapInfo,
  type EdgeSwapPlugin,
  type EdgeSwapQuote,
  type EdgeSwapRequest,
  type EdgeTransaction,
  SwapCurrencyError
} from 'edge-core-js/types'

import { makeSwapPluginQuote } from '../swap-helpers.js'

const INVALID_CURRENCY_CODES = {}

// Invalid currency codes should *not* have transcribed codes
// because currency codes with transcribed versions are NOT invalid
// TODO: figure out what's this
const CURRENCY_CODE_TRANSCRIPTION = {
  // Edge currencyCode: exchangeCurrencyCode
  USDT: 'USDT20'
}

const pluginId = 'sideshift'
const swapInfo: EdgeSwapInfo = {
  pluginId,
  displayName: 'SideShift.ai',
  supportEmail: 'help@sideshift.ai'
}
type FixedQuote = {
  createdAt: string,
  depositAmount: string,
  depositMethod: string,
  expiresAt: string,
  id: string,
  rate: string,
  settleAmount: string,
  settleMethod: string
}

type FixedQuoteRequestParams = {
  depositMethod: string,
  settlMethod: string,
  depositAmount: string
}

type OrderRequest = {
  createdAt: string,
  createdAtISO: string,
  expiresAt: Date,
  expiresAtIso: string,
  depositAddress: {
    address: string
  },
  depositMethod: string,
  id: string,
  orderId: string,
  settleAddress: {
    address: string
  },
  settleMethod: string,
  depositMax: string,
  depositMin: string,
  quoteId: string,
  settleAmount: string,
  depositAmount: string,
  deposits: Array<any>
}

type OrderRequestParams = {
  type: string,
  quoteId: string,
  affiliateId: string,
  sessionSecret?: string,
  settleAddress: string
}

type Rate = {
  rate: number,
  min: string,
  max: string
}

const dontUseLegacy = {
  // TODO: clarify with Andreas
  DGB: true
}

async function getAddress(
  wallet: EdgeCurrencyWallet,
  currencyCode: string
): Promise<string> {
  const addressInfo = await wallet.getReceiveAddress({ currencyCode })
  return addressInfo.legacyAddress && !dontUseLegacy[currencyCode]
    ? addressInfo.legacyAddress
    : addressInfo.publicAddress
}

async function checkReply(uri: string, reply: EdgeFetchResponse) {
  let replyJson
  try {
    replyJson = await reply.json()
  } catch (e) {
    // TODO: discuss error handling with Andreas
    throw new Error(
      `SideShift.ai returned error code ${reply.status} (no JSON)`
    )
  }
  if (
    reply.status === 403 &&
    replyJson != null &&
    /geo/.test(replyJson.error) // TODO: This could be used for transactions coming from restriced countries
  ) {
    throw new SwapPermissionError(swapInfo, 'geoRestriction')
  }
}

export function makeSideShiftPlugin(
  opts: EdgeCorePluginOptions
): EdgeSwapPlugin {
  const { initOptions, io } = opts
  const { fetchCors = io.fetch } = io // TODO: use fetch or fetchCors?
  const { apiKey, secret } = initOptions
  const baseUrl = 'https://sideshift.ai/api/'

  // TODO: apiKey and secret are provided in edge-react-gui env.json if needed
  if (apiKey == null || secret == null) {
    throw new Error('No SideShift.ai apiKey or secret provided.')
  }

  async function get(path: string): Promise<Rate> {
    const url = `${baseUrl}${path}`
    const reply = await fetchCors(url)
    return reply
  }

  async function post(path, body): Promise<any> {
    const url = `${baseUrl}${path}`
    const reply = await fetchCors(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json' // TODO: need anything else here?
      },
      body: JSON.stringify(body)
    })

    return checkReply(url, reply)
  }

  const out: EdgeSwapPlugin = {
    swapInfo,

    async fetchSwapQuote(
      request: EdgeSwapRequest,
      userSettings: Object | void,
      opts: { promoCode?: string }
    ): Promise<EdgeSwapQuote> {
      // const { promoCode } = opts //TODO: do we need promoCode?
      if (
        // if either currencyCode is invalid *and* doesn't have a transcription
        INVALID_CURRENCY_CODES[request.fromCurrencyCode] ||
        INVALID_CURRENCY_CODES[request.toCurrencyCode]
      ) {
        throw new SwapCurrencyError(
          swapInfo,
          request.fromCurrencyCode,
          request.toCurrencyCode
        )
      }

      const [depositAddress, settleAddress] = await Promise.all([
        getAddress(request.fromWallet, request.fromCurrencyCode),
        getAddress(request.toWallet, request.toCurrencyCode)
      ])
      const quoteAmount =
        request.quoteFor === 'from'
          ? await request.fromWallet.nativeToDenomination(
              request.nativeAmount,
              request.fromCurrencyCode
            )
          : await request.toWallet.nativeToDenomination(
              request.nativeAmount,
              request.toCurrencyCode
            )

      let safeFromCurrencyCode = request.fromCurrencyCode
      let safeToCurrencyCode = request.toCurrencyCode
      if (CURRENCY_CODE_TRANSCRIPTION[request.fromCurrencyCode]) {
        safeFromCurrencyCode = CURRENCY_CODE_TRANSCRIPTION[
          request.fromCurrencyCode
        ].toLowerCase()
      }
      if (CURRENCY_CODE_TRANSCRIPTION[request.toCurrencyCode]) {
        safeToCurrencyCode = CURRENCY_CODE_TRANSCRIPTION[
          request.toCurrencyCode
        ].toLowerCase() // TODO: does the api always expect lower case deposit and settle methods?
      }

      const fixedRateQuoteParams: FixedQuoteRequestParams = {
        depositMethod: safeFromCurrencyCode,
        settlMethod: safeToCurrencyCode,
        depositAmount: quoteAmount
      }

      const fixedRateQuote: FixedQuote = await post(
        'quotes',
        fixedRateQuoteParams
      )

      const ratePath =
        request.quoteFor === 'from'
          ? `pairs/${safeFromCurrencyCode}/${safeToCurrencyCode}`
          : `pairs/${safeToCurrencyCode}/${safeFromCurrencyCode}`

      const rate: Rate = await get(ratePath)

      const nativeMin = await request.fromWallet.denominationToNative(
        rate.min,
        request.fromCurrencyCode
      )

      const nativeMax = await request.fromWallet.denominationToNative(
        rate.max,
        request.fromCurrencyCode
      )

      if (lt(request.nativeAmount, nativeMin)) {
        throw new SwapBelowLimitError(swapInfo, nativeMin)
      }

      if (gt(request.nativeAmount, nativeMax)) {
        throw new SwapAboveLimitError(swapInfo, nativeMax)
      }

      const orderRequestParams: OrderRequestParams = {
        type: 'fixed',
        quoteId: fixedRateQuote.id,
        affiliateId: 'whatever', // TODO: should we hardcode it here or in the ENV.json?
        sessionSecret: 'this can be empty right?', // TODO: clarify with Andreas
        settleAddress
      }

      const quoteInfo: OrderRequest = await post('orders', orderRequestParams)

      const spendInfoAmount = await request.fromWallet.denominationToNative(
        quoteInfo.depositAmount,
        request.fromCurrencyCode.toUpperCase()
      )

      const amountExpectedFromNative = await request.fromWallet.denominationToNative(
        quoteInfo.depositAmount,
        request.fromCurrencyCode
      )

      const amountExpectedToNative = await request.fromWallet.denominationToNative(
        quoteInfo.settleAmount,
        request.toCurrencyCode
      )

      const spendInfo: EdgeSpendInfo = {
        currencyCode: request.fromCurrencyCode,
        spendTargets: [
          {
            nativeAmount: spendInfoAmount,
            publicAddress: quoteInfo.settleAddress.address,
            uniqueIdentifier: quoteInfo.id || undefined // TODO: not sure if this is right or we need this
          }
        ],
        networkFeeOption:
          request.fromCurrencyCode.toUpperCase() === 'BTC'
            ? 'high'
            : 'standard', // TODO: figure out if this is specific to Edge, other plugins have the same
        swapData: {
          orderId: quoteInfo.orderId,
          isEstimate: false,
          payoutAddress: settleAddress, // TODO: this could be quoteInfo.settleAddress.address as well
          payoutCurrencyCode: request.toCurrencyCode, // TODO: this could be quoteInfo.settleMethod as well
          payoutNativeAmount: amountExpectedToNative,
          payoutWalletId: request.toWallet.id,
          plugin: { ...swapInfo },
          refundAddress: depositAddress
        }
      }
      const tx: EdgeTransaction = await request.fromWallet.makeSpend(spendInfo)

      return makeSwapPluginQuote(
        request,
        amountExpectedFromNative,
        amountExpectedToNative,
        tx,
        settleAddress,
        'sideshift',
        false,
        quoteInfo.expiresAt,
        quoteInfo.id
      )
    }
  }

  return out
}
