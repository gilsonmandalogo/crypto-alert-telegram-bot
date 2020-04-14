import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import * as exchangePool from './exchangePool';
import * as globals from './globals';
import * as types from './types';
import * as utils from './utils';
import * as secrets from './secrets';

const runtimeOptions: functions.RuntimeOptions = {
  maxInstances: 3,
  memory: "128MB",
  timeoutSeconds: 10,
};

const db = admin.firestore();

const HELP = `Possible commands:

/help — Display this help.
/donate — Makes his creator happy 🙂.
/now {pair} — Display the current price of given pair. E.g. /now btc/eur
/setalert — Creates a new alert.
/myalerts — Display all your alerts.
/deletealert — Deletes a alert.`;

const DONATE_MSG = `Thank you, I really appreciate your help to main my services running.
What currency do you want to transfer?`;

const CALLBACKS = {
  priceAlert: "priceAlert",
  above: "above",
  below: "below",
  deleteAlert: "deleteAlert",
  donateBtc: "donateBtc",
  donateBch: "donateBch",
  donateEth: "donateEth",
  donateLtc: "donateLtc",
};

const DEFAULT_EXCHANGE = "binance";

const MESSAGES_REPLY = {
  priceAlertPair: "Price alert 1/4: Which pair?",
  priceAlertPrice: (pair: string) => `Price alert 2/4\nPair: ${pair}\nWhich price?`,
  priceAlertDirection: (pair: string, price: string) => `Price alert 3/4\nPair: ${pair}\nPrice: ${price}\nWhen goes above or below that price?`,
  priceAlertExchange: (pair: string, price: string, direction: string) => `Price alert 4/4\nPair: ${pair}\nPrice: ${price}\nDirection: ${direction}\nWhich exchange?`,
};

const MESSAGES = {
  noAlerts: "You don't have alerts yet. You can create one by using /setalert command"
}

function findMessageSection(msg: string, section: string) {
  section += ": ";
  const index = msg.indexOf(section) + section.length;
  return msg.substring(index, msg.indexOf("\n", index));
}

function isTelegramMessage(req: functions.https.Request) {
  return req.body?.message;
};

function isTelegramMessageReply(req: functions.https.Request) {
  return req.body.message.reply_to_message;
};

function isTelegramCallback(req: functions.https.Request) {
  return req.body?.callback_query;
}

function isTelegramNemGroupMember(req: functions.https.Request) {
  return req.body?.message?.new_chat_member;
}

function reply(res: functions.Response, chat_id: string, text?: string, reply_markup?: object) {
  return res.status(200).json({
    method: 'sendMessage',
    chat_id,
    text,
    reply_markup,
  });
}

function replyWithPhoto(res: functions.Response, chat_id: string, photo: string, caption?: string) {
  return res.status(200).json({
    method: 'sendPhoto',
    chat_id,
    photo,
    caption,
  });
}

async function now(symbol: string) {
  const exchange = exchangePool.getExchange(DEFAULT_EXCHANGE);
  await exchange.loadMarkets();
  symbol = symbol.toUpperCase();

  if (exchange.symbols.includes(symbol)) {
    const ticker = await exchange.fetchTicker(symbol);
    const currency = utils.extractSencondPartSymbol(symbol);
    return `${ticker.last?.toString()} ${currency}`;
  }

  return `Unknown pair: ${symbol}`;
}

function displayAlert({ type, pair, direction, price, exchange }: types.Alert, index: number) {
  const currency = utils.extractSencondPartSymbol(pair);
  return `${index +1}: ${type} for ${pair}, when price goes ${direction} ${price} ${currency} on ${exchange}`;
}

const displayWelcome = (userName: string) => `Welcome ${userName}, I'm @CryptoAlertBot 🤖.
I'll help to keep you informed about changes in the cryptocurrency world.
If I was useful to you, please consider a donation to his creator at /donate command, I use a backend service that have costs.`;

export const receiveMessage = functions.region('europe-west3').runWith(runtimeOptions).https.onRequest(async (req, res) => {
  try {
    if (req.params[0].substring(1) !== secrets.telegramBotToken) {
      console.log(`Unauthorized access from ${req.ip}`);
      return res.sendStatus(403);
    }

    let replyMsg: string | undefined;
    let replyMarkup: object | undefined;

    if (isTelegramNemGroupMember(req)) {
      const chatId = req.body.message.chat.id;
      const newMember = req.body.message.new_chat_member;
      if (newMember.is_bot) {
        replyMsg = `Welcome brother ${newMember.first_name}. Together we make this world better 🤖.`;
      } else {
        replyMsg = displayWelcome(newMember.first_name);
      }

      return reply(res, chatId, replyMsg, replyMarkup);
    }

    if (isTelegramMessage(req)) {
      if (!req.body.message.text) {
        return res.sendStatus(200);
      }

      const chatId = req.body.message.chat.id;
      const chatsRef = db.collection(globals.COLLECTIONS.chats).doc(chatId.toString());
      const chatsSnap = await chatsRef.get();

      if (chatsSnap.exists) {
        const receivedMsg = req.body.message.text.toLowerCase().trim();

        if (isTelegramMessageReply(req)) {
          const text = req.body.message.reply_to_message.text;
          if (text === MESSAGES_REPLY.priceAlertPair) {
            const pair = receivedMsg.toUpperCase();
            replyMsg = MESSAGES_REPLY.priceAlertPrice(pair);
            replyMarkup = {
              force_reply: true,
            };
          } else if (text.startsWith('Price alert 2/4')) {
            const pair = findMessageSection(text, "Pair");
            const price = receivedMsg;
            replyMsg = MESSAGES_REPLY.priceAlertDirection(pair, price);
            replyMarkup = {
              inline_keyboard: [[{
                text: "Above",
                callback_data: CALLBACKS.above,
              }, {
                text: "Below",
                callback_data: CALLBACKS.below,
              }]],
            };
          } else if (text.startsWith('Price alert 4/4')) {
            const pair = findMessageSection(text, "Pair");
            const price = Number(findMessageSection(text, "Price"));
            const direction = findMessageSection(text, "Direction");
            const exchange = receivedMsg;
            chatsRef.collection(globals.COLLECTIONS.alerts).add({
              type: "Price alert",
              pair,
              price,
              direction,
              exchange,
            } as types.Alert);

            const currency = utils.extractSencondPartSymbol(pair);
            replyMsg = `Created a price alert for ${pair}, when price goes ${direction} ${price} ${currency} on ${exchange}`;
          }

          return reply(res, chatId, replyMsg, replyMarkup);
        }

        const firstSpaceIndex = receivedMsg.indexOf(' ');
        const command = receivedMsg.includes(' ') ? receivedMsg.substring(0, firstSpaceIndex) : receivedMsg;
        const rest = firstSpaceIndex === -1 ? '' : receivedMsg.substring(firstSpaceIndex +1);

        switch (command) {
          case '/help':
            replyMsg = HELP;
            break;
          case '/now':
            if (rest.length < 1) {
              replyMsg = `/now command needs 1 argument. ${HELP}`;
              break;
            }

            replyMsg = await now(rest);
            break;
          case '/setalert':
            replyMsg = 'What kind of alert?';
            replyMarkup = {
              inline_keyboard: [[{
                text: "Price alert",
                callback_data: CALLBACKS.priceAlert,
              }]],
            };
            break;
          case '/myalerts':
            const get = await chatsRef.collection(globals.COLLECTIONS.alerts).get();
            const alerts = get.docs.map(query => query.data() as unknown as types.Alert).map((alert, i) => displayAlert(alert, i));

            if (alerts.length === 0) {
              replyMsg = MESSAGES.noAlerts;
              break;
            }

            replyMsg = `Your alerts:\n${alerts.join('\n')}`;
            break;
          case '/deletealert':
            const get2 = await chatsRef.collection(globals.COLLECTIONS.alerts).get();
            const alerts2 = get2.docs.map(query => query.data() as unknown as types.Alert).map((alert, i) => ([{
              text: displayAlert(alert, i),
              callback_data: CALLBACKS.deleteAlert + i,
            }]));

            if (alerts2.length === 0) {
              replyMsg = MESSAGES.noAlerts;
              break;
            }

            replyMsg = 'Which one?';
            replyMarkup = {
              inline_keyboard: alerts2,
            };
            break;
          case '/donate':
            replyMsg = DONATE_MSG;
            replyMarkup = {
              inline_keyboard: [[{
                text: "BTC",
                callback_data: CALLBACKS.donateBtc,
              }, {
                text: "BCH",
                callback_data: CALLBACKS.donateBch,
              }, {
                text: "ETH",
                callback_data: CALLBACKS.donateEth,
              }, {
                text: "LTC",
                callback_data: CALLBACKS.donateLtc,
              }]],
            };
            break;
          default:
            replyMsg = `Unknown command. ${HELP}`;
            break;
        }

        return reply(res, chatId, replyMsg, replyMarkup);
      }

      chatsRef.set({});

      return reply(res, chatId, displayWelcome(req.body.message.from.first_name));
    };

    if (isTelegramCallback(req)) {
      const chatId = req.body.callback_query.message.chat.id;

      switch (req.body.callback_query.data) {
        case CALLBACKS.priceAlert:
          replyMsg = MESSAGES_REPLY.priceAlertPair,
          replyMarkup = {
            force_reply: true,
          };
          break;
        case CALLBACKS.above:
        case CALLBACKS.below:
          const text = req.body.callback_query.message.text;
          const pair = findMessageSection(text, "Pair");
          const price = findMessageSection(text, "Price");
          const direction = req.body.callback_query.data;
          replyMsg = MESSAGES_REPLY.priceAlertExchange(pair, price, direction);
          replyMarkup = {
            force_reply: true,
          };
          break;
        case CALLBACKS.donateBtc:
          return replyWithPhoto(res, chatId, 'https://i.ibb.co/FHN2Z4B/Bitcoin-QR-code.png', '33TwXHzMTpSNMJZ4JcwExLExsF3BshBUPE');
        case CALLBACKS.donateBch:
          return replyWithPhoto(res, chatId, 'https://i.ibb.co/7NR3Jvb/Bitcoin-Cash-QR-code.png', 'qpfu774dk0n732su8u9yvzxyctgeq37q55dpt82ytr');
        case CALLBACKS.donateEth:
          return replyWithPhoto(res, chatId, 'https://i.ibb.co/kyXhH34/Ethereum-QR-code.png', '0xa772c6bab9d175256ff635843c461d3f65a7236b');
        case CALLBACKS.donateLtc:
          return replyWithPhoto(res, chatId, 'https://i.ibb.co/BrhThhH/Litecoin-QR-code.png', 'M9adpiNQXsbEf7j5ZVnuDCGNoXT7oMW3vd');
        default:
          if (req.body.callback_query.data.startsWith(CALLBACKS.deleteAlert)) {
            const id = req.body.callback_query.data.substring(CALLBACKS.deleteAlert.length);
            const chatsRef = db.collection(globals.COLLECTIONS.chats).doc(chatId.toString());
            const snapshot = await chatsRef.collection(globals.COLLECTIONS.alerts).get();
            snapshot.docs[id].ref.delete();
            replyMsg = `Deleted alert ${Number(id) +1}`;
          }
          break;
      }

      return reply(res, chatId, replyMsg, replyMarkup);
    }

    return res.sendStatus(400);
  } catch(e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});
