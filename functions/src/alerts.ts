import * as ccxt from 'ccxt';
import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import fetch, { Headers } from 'node-fetch';
import * as exchangePool from './exchangePool';
import * as globals from './globals';
import * as secrets from './secrets';
import * as types from './types';
import * as utils from './utils';

const runtimeOptions: functions.RuntimeOptions = {
  maxInstances: 1,
  memory: "128MB",
  timeoutSeconds: 10,
};

const db = admin.firestore();

async function sendMessage(chat_id: string, text: string) {
  const headers = new Headers();
  headers.append('Content-Type', 'application/json');
  const res = await fetch(`https://api.telegram.org/bot${secrets.telegramBotToken}/sendMessage`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      chat_id,
      text
    }),
  });

  return res.ok;
}

export const alerts = functions.region('europe-west3').runWith(runtimeOptions).pubsub.schedule('every 5 minutes').onRun(async () => {
  const fiveMinutesAgo = Date.now() - 300000;
  const fetchCache = new Map<string, ccxt.OHLCV[]>();
  const query = await db.collectionGroup(globals.COLLECTIONS.alerts).where('type', '==', 'Price alert').get();

  for (const doc of query.docs) {
    const alert = doc.data() as types.Alert;
    const exchange = exchangePool.getExchange(alert.exchange);
    const cached = fetchCache.get(alert.exchange + alert.pair);
    let ohlcv: ccxt.OHLCV[];

    if (cached) {
      ohlcv = cached;
    } else {
      ohlcv = await exchange.fetchOHLCV(alert.pair, '5m', fiveMinutesAgo, 1);
      fetchCache.set(alert.exchange + alert.pair, ohlcv);
    }

    const triggerAlert = async (price: number) => {
      const chatId = doc.ref.parent.parent?.id;

      if (!chatId) {
        throw new Error('No chatId found');
      }

      const from = utils.extractFirstPartSymbol(alert.pair);
      const to = utils.extractSencondPartSymbol(alert.pair);

      if (await sendMessage(chatId, `⚠️ ${alert.type}: ${from} has reached the price of ${price} ${to}!\nI sent this message because you requested me to inform when ${from} goes ${alert.direction} ${alert.price} ${to} on ${alert.exchange}.`)) {
        await doc.ref.delete();
      }
    }

    const firstOhlcv = ohlcv[0];

    if (alert.direction === 'above') {
      const high = firstOhlcv[2];

      if (high >= alert.price) {
        await triggerAlert(high);
        continue;
      }
    }

    if (alert.direction === 'below') {
      const low = firstOhlcv[3];

      if (low <= alert.price) {
        await triggerAlert(low);
        continue;
      }
    }
  }
});
