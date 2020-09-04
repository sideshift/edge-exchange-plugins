// @flow

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
import hashjs from 'hash.js'
import { base16 } from 'rfc4648'
import utf8Codec from 'utf8'

import { makeSwapPluginQuote } from '../swap-helpers.js'

const INVALID_CURRENCY_CODES = {}

// Invalid currency codes should *not* have transcribed codes
// because currency codes with transcribed versions are NOT invalid
const CURRENCY_CODE_TRANSCRIPTION = {
  // Edge currencyCode: exchangeCurrencyCode
  USDT: 'USDT20'
}

function hmacSha512(data: Uint8Array, key: Uint8Array): Uint8Array {
  const hmac = hashjs.hmac(hashjs.sha512, key)
  return hmac.update(data).digest()
}

function parseUtf8(text: string): Uint8Array {
  const byteString: string = utf8Codec.encode(text)
  const out = new Uint8Array(byteString.length)

  for (let i = 0; i < byteString.length; ++i) {
    out[i] = byteString.charCodeAt(i)
  }

  return out
}

const pluginId = 'sideshift'
const swapInfo: EdgeSwapInfo = {
  pluginId,
  displayName: 'SideShift.ai',
  supportEmail: 'help@sideshift.ai'
}
const uri = 'https://sideshift.ai/api'
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

const dontUseLegacy = {
  // TODO: clarify with Andreas
  DGB: true
}

// returns the settleAddress from Edge wallet
async function getAddress(
  wallet: EdgeCurrencyWallet,
  currencyCode: string
): Promise<string> {
  const addressInfo = await wallet.getReceiveAddress({ currencyCode })
  return addressInfo.legacyAddress && !dontUseLegacy[currencyCode]
    ? addressInfo.legacyAddress
    : addressInfo.publicAddress
}

// TODO: Replace this with better code
function checkReplyforError(reply: Object, request: EdgeSwapRequest) {
  if (reply.error != null) {
    if (
      reply.error.code === -32602 ||
      /Invalid currency:/.test(reply.error.message) // TODO: clarify with Andreas how our endpoint throws errors
    ) {
      throw new SwapCurrencyError(
        swapInfo,
        request.fromCurrencyCode,
        request.toCurrencyCode
      )
    }
    throw new Error('SideShift.ai error: ' + JSON.stringify(reply.error))
  }
}

export function makeSideShiftPlugin(
  opts: EdgeCorePluginOptions
): EdgeSwapPlugin {
  const { initOptions, io } = opts
  const { fetchCors = io.fetch } = io
  const { apiKey, secret } = initOptions

  if (apiKey == null || secret == null) {
    throw new Error('No SideShift.ai apiKey or secret provided.')
  }
  const parsedSecret = parseUtf8(secret)

  // TODO: replace this function with better code
  async function call(json: any, promoCode?: string) {
    // TODO: do we need promocode?
    const body = JSON.stringify(json)
    const sign = base16
      .stringify(hmacSha512(parseUtf8(body), parsedSecret))
      .toLowerCase()

    const headers: { [header: string]: string } = {
      'Content-Type': 'application/json',
      'api-key': apiKey,
      sign
    }
    if (promoCode != null) headers['X-Promo-Code'] = promoCode
    const response = await fetchCors(uri, { method: 'POST', body, headers })

    if (!response.ok) {
      throw new Error(`SideShift.ai returned error code ${response.status}`)
    }
    return response.json()
  }

  const out: EdgeSwapPlugin = {
    swapInfo,
    async fetchSwapQuote(
      request: EdgeSwapRequest,
      userSettings: Object | void,
      opts: { promoCode?: string }
    ): Promise<EdgeSwapQuote> {
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
      const fixedPromise = this.getFixedQuote(request, userSettings, opts)
      // const estimatePromise = this.getEstimate(request, userSettings, opts)
      try {
        const fixedResult = await fixedPromise
        return fixedResult
      } catch (e) {
        // TODO: genuinely confused why estimateResult is in the catch block
        // const estimateResult = await estimatePromise
        // return estimateResult
        return e
      }
    },

    async getFixedQuote(
      request: EdgeSwapRequest,
      userSettings: Object | void,
      opts: { promoCode?: string }
    ): Promise<EdgeSwapQuote> {
      const { promoCode } = opts
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
        safeFromCurrencyCode =
          CURRENCY_CODE_TRANSCRIPTION[request.fromCurrencyCode]
      }
      if (CURRENCY_CODE_TRANSCRIPTION[request.toCurrencyCode]) {
        safeToCurrencyCode = CURRENCY_CODE_TRANSCRIPTION[request.toCurrencyCode]
      }
      const fixedRateQuote: FixedQuote = await call({
        jsonrpc: '2.0', // TODO: clarify with Andreas
        method: 'quotes',
        params: {
          depositMethod: safeFromCurrencyCode.toLowerCase(), // TODO: does the api always expect lower case deposit and settle methods?
          settlMethod: safeToCurrencyCode.toLowerCase(),
          depositAmount: quoteAmount
        }
      })
      // const min =
      //   request.quoteFor === 'from'
      //     ? fixedRateQuote.result.minFrom
      //     : fixedRateQuote.result.minTo
      // const max =
      //   request.quoteFor === 'from'
      //     ? fixedRateQuote.result.maxFrom
      //     : fixedRateQuote.result.maxTo
      // const nativeMin = await request.fromWallet.denominationToNative(
      //   min,
      //   request.fromCurrencyCode
      // )
      // const nativeMax = await request.fromWallet.denominationToNative(
      //   max,
      //   request.fromCurrencyCode
      // )
      // if (lt(request.nativeAmount, nativeMin)) {
      //   throw new SwapBelowLimitError(swapInfo, nativeMin) // TODO: figure out if we can ignore throwing these errors
      // }
      // if (gt(request.nativeAmount, nativeMax)) {
      //   throw new SwapAboveLimitError(swapInfo, nativeMax) // TODO: clarify with Andreas if there are upper and lower limits to swap
      // }

      const params: OrderRequestParams = {
        type: 'fixed',
        quoteId: fixedRateQuote.id,
        affiliateId: 'whatever',
        sessionSecret: 'this can be empty right?', // TODO
        settleAddress: settleAddress
      }

      const quoteInfo: OrderRequest = await call(
        {
          jsonrpc: '2.0',
          method: 'orders',
          params
        },
        promoCode
      )
      checkReplyforError(quoteInfo, request)
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
            uniqueIdentifier: quoteInfo.id || undefined // TODO: not sure if this is right
          }
        ],
        networkFeeOption:
          request.fromCurrencyCode.toUpperCase() === 'BTC'
            ? 'high'
            : 'standard', // TODO: figure out if this is specific to Edge
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
        quoteInfo.expiresAt, // TODO: check if ISO or js date object type is needed here
        quoteInfo.id
      )
    }
  }

  return out
}
