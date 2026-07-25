require("dotenv").config();
const _T = require("node-telegram-bot-api");
const TelegramBot = _T.default || _T;
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const knex = require("knex");

const db = knex({
  client: "postgresql",
  connection: {
    database: process.env.DB_DATABASE,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
  },
});

const token = process.env.TELEGRAM_AUDIO_BOT_TOKEN;

if (!token) {
  console.log("Telegram Audio Bot Token is missing in .env");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const PAGE_SIZE = 10;
const userStates = {};

const isAdmin = async (chatId) => {
  const admin = await db("admin")
    .where({ telegram_chat_id: String(chatId) })
    .first();
  return !!admin;
};

const mainMenuOptions = {
  reply_markup: {
    keyboard: [
      [{ text: "📋 Savollar ro'yxati" }, { text: "🌐 Til bo'yicha ovoz qo'shish" }],
      [{ text: "📊 Statistika" }]
    ],
    resize_keyboard: true
  }
};

const langMenuOptions = {
  reply_markup: {
    keyboard: [
      [{ text: "🇺🇿 O'zbekcha" }, { text: "🇷🇺 Ruscha" }],
      [{ text: "🇺🇿 Kirillcha" }],
      [{ text: "🔙 Bosh menyu" }]
    ],
    resize_keyboard: true
  }
};

async function triggerRecordingFlow(chatId, qId, lang, messageIdToEdit = null) {
  userStates[chatId] = { mode: "lang_filter", action: "recording", questionId: qId, lang };

  const langName = lang === "uz" ? "O'zbekcha" : lang === "ru" ? "Ruscha" : "Kirillcha";
  const question = await db("questions").where({ id: qId }).first();
  const optionsRows = await db("options").where({ question_id: qId }).orderBy("id", "asc");

  if (!question) {
     const txt = "❌ <b>Savol topilmadi.</b>";
     if (messageIdToEdit) return bot.editMessageText(txt, { chat_id: chatId, message_id: messageIdToEdit, parse_mode: "HTML" }).catch(()=>{});
     return bot.sendMessage(chatId, txt, { parse_mode: "HTML" });
  }

  if (messageIdToEdit) {
    bot.deleteMessage(chatId, messageIdToEdit).catch(()=>{});
  }

  let textLang = "";
  let isFallback = false;

  if (lang === "uz") {
    textLang = question.content_uz || "";
  } else if (lang === "ru") {
    if (!question.content_ru || question.content_ru.trim() === "") {
      textLang = question.content_uz || "";
      isFallback = true;
    } else {
      textLang = question.content_ru;
    }
  } else if (lang === "kr") {
    if (!question.content_kr || question.content_kr.trim() === "") {
      textLang = question.content_uz || "";
      isFallback = true;
    } else {
      textLang = question.content_kr;
    }
  }

  let text = `📌 <b>Savol ID:</b> <code>${question.id}</code>\n\n`;
  if (isFallback) {
    text += `⚠️ <b>DIQQAT:</b> Bu til hozircha bazaga kiritilmagan, shuning uchun savolni va variantlarni O'zbek tilida ko'rib turibsiz.\n\n`;
  }
  
  const cleanTextLang = textLang.replace(/<[^>]*>?/gm, '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").trim();
  text += `📝 <b>${langName} tilidagi matn:</b>\n\n${cleanTextLang}`;

  if (optionsRows.length > 0) {
    text += "\n\n<b>Variantlar:</b>\n";
    optionsRows.forEach((opt, idx) => {
      let optLang = "";
      if (lang === "uz") {
        optLang = opt.content_uz || "";
      } else if (lang === "ru") {
        optLang = opt.content_ru || opt.content_uz || "";
      } else if (lang === "kr") {
        optLang = opt.content_kr || opt.content_uz || "";
      }
      
      const optClean = optLang.replace(/<[^>]*>?/gm, '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").trim();
      if (optClean) {
        text += `<b>${idx + 1})</b> ${optClean} ${opt.is_correct ? '✅' : ''}\n`;
      }
    });
  }

  const keyboardOptions = {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "🔙 Ro'yxatga qaytish", callback_data: `page_1_${lang}` }]]
    }
  };

  if (question.image_url) {
    const imagePath = path.join(__dirname, "../backend", question.image_url);
    if (fs.existsSync(imagePath)) {
      await bot.sendPhoto(chatId, imagePath, { caption: text, ...keyboardOptions });
    } else {
      await bot.sendMessage(chatId, text, keyboardOptions);
    }
  } else {
    await bot.sendMessage(chatId, text, keyboardOptions);
  }

  bot.sendMessage(
    chatId,
    `🎤 Endi <b>${langName}</b> tilida ovozli tushuntirish yozib yuboring.\n<i>(Voice yuboring yoki Audio fayl yuklang)</i>`,
    { parse_mode: "HTML" }
  );
}


async function showQuestion(chatId, questionId, messageIdToEdit = null) {
  const state = userStates[chatId];
  // Agar biz til rejimida bo'lsak (lang_filter), darhol recording yuboramiz
  if (state && state.mode === "lang_filter" && state.lang) {
     return triggerRecordingFlow(chatId, questionId, state.lang, messageIdToEdit);
  }

  const question = await db("questions").where({ id: questionId }).first();
  if (!question) {
    const txt = "❌ <b>Savol topilmadi.</b>\nIltimos, ID raqamini tekshirib qayta urinib ko'ring.";
    if (messageIdToEdit) return bot.editMessageText(txt, { chat_id: chatId, message_id: messageIdToEdit, parse_mode: "HTML" }).catch(()=>{});
    return bot.sendMessage(chatId, txt, { parse_mode: "HTML" });
  }

  const keyboard = [];
  
  const uzRow = [{ text: `O'zbekcha 🇺🇿${question.audio_explanation_uz ? ' ✅' : ''}`, callback_data: `record_${questionId}_uz` }];
  if (question.audio_explanation_uz) uzRow.push({ text: `🗑`, callback_data: `delete_${questionId}_uz` });
  keyboard.push(uzRow);

  const ruRow = [{ text: `Ruscha 🇷🇺${question.audio_explanation_ru ? ' ✅' : ''}`, callback_data: `record_${questionId}_ru` }];
  if (question.audio_explanation_ru) ruRow.push({ text: `🗑`, callback_data: `delete_${questionId}_ru` });
  keyboard.push(ruRow);

  const krRow = [{ text: `Kirillcha 🇺🇿${question.audio_explanation_kr ? ' ✅' : ''}`, callback_data: `record_${questionId}_kr` }];
  if (question.audio_explanation_kr) krRow.push({ text: `🗑`, callback_data: `delete_${questionId}_kr` });
  keyboard.push(krRow);

  keyboard.push([{ text: "🔙 Ro'yxatga qaytish", callback_data: `page_1` }]);

  const options = {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: keyboard,
    },
  };

  const rawText = question.content_uz || question.content_ru || question.content_kr || "";
  const cleanText = rawText.replace(/<[^>]*>?/gm, '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").trim();
  let text = `📌 <b>Savol ID:</b> <code>${question.id}</code>\n\n${cleanText.substring(0, 1000)}`;

  if (question.image_url) {
    const imagePath = path.join(__dirname, "../backend", question.image_url);
    if (fs.existsSync(imagePath)) {
      if (messageIdToEdit) bot.deleteMessage(chatId, messageIdToEdit).catch(()=>{});
      return bot.sendPhoto(chatId, imagePath, { caption: text, parse_mode: "HTML", reply_markup: options.reply_markup });
    }
  }

  if (messageIdToEdit) {
    bot.editMessageText(text, { chat_id: chatId, message_id: messageIdToEdit, parse_mode: "HTML", reply_markup: options.reply_markup }).catch((err) => {
      bot.deleteMessage(chatId, messageIdToEdit).catch(()=>{});
      bot.sendMessage(chatId, text, options);
    });
  } else {
    bot.sendMessage(chatId, text, options);
  }
}

async function sendQuestionsPage(chatId, page = 1, messageIdToEdit = null, filterLang = null) {
  const offset = (page - 1) * PAGE_SIZE;
  
  let query = db("questions").select("id", "content_uz", "content_ru", "content_kr");
  let countQuery = db("questions").count("id as count");

  if (filterLang && filterLang !== "all") {
    const colName = `audio_explanation_${filterLang}`;
    query = query.whereNull(colName);
    countQuery = countQuery.whereNull(colName);
  }

  const questions = await query.orderBy("id", "asc").limit(PAGE_SIZE).offset(offset);
  const totalRes = await countQuery.first();
  const total = parseInt(totalRes.count) || 0;
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

  if (questions.length === 0) {
    const txt = filterLang && filterLang !== "all" ? "🎉 <b>Ushbu til bo'yicha barcha savollarga ovoz kiritilgan!</b>" : "❌ <b>Savollar topilmadi.</b>";
    if (messageIdToEdit) return bot.editMessageText(txt, { chat_id: chatId, message_id: messageIdToEdit, parse_mode: "HTML" }).catch(()=>{});
    return bot.sendMessage(chatId, txt, { parse_mode: "HTML" });
  }

  const langName = filterLang === "uz" ? "O'zbekcha" : filterLang === "ru" ? "Ruscha" : filterLang === "kr" ? "Kirillcha" : "";
  let text = filterLang && filterLang !== "all" 
    ? `🎙 <b>${langName} tilida ovozi yo'q savollar</b> (<i>${page}-sahifa / ${totalPages}</i>):\n\n`
    : `📋 <b>Savollar ro'yxati</b> (<i>${page}-sahifa / ${totalPages}</i>):\n\n`;

  const keyboardRow1 = [];
  const keyboardRow2 = [];

  questions.forEach((q, index) => {
    const rawText = q.content_uz || q.content_ru || q.content_kr || "";
    const cleanText = rawText.replace(/<[^>]*>?/gm, '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").trim().substring(0, 50);
    text += `🔹 <b>ID: ${q.id}</b> - <i>${cleanText}...</i>\n`;
    
    if (index < 5) keyboardRow1.push({ text: `${q.id}`, callback_data: `showq_${q.id}` });
    else keyboardRow2.push({ text: `${q.id}`, callback_data: `showq_${q.id}` });
  });

  const paginationRow = [];
  const mode = filterLang && filterLang !== "all" ? filterLang : "all";
  if (page > 1) {
    paginationRow.push({ text: "⬅️ Oldingi", callback_data: `page_${page - 1}_${mode}` });
  }
  if (page < totalPages) {
    paginationRow.push({ text: "Keyingi ➡️", callback_data: `page_${page + 1}_${mode}` });
  }

  const inline_keyboard = [];
  if (keyboardRow1.length > 0) inline_keyboard.push(keyboardRow1);
  if (keyboardRow2.length > 0) inline_keyboard.push(keyboardRow2);
  if (paginationRow.length > 0) inline_keyboard.push(paginationRow);

  const options = { parse_mode: "HTML", reply_markup: { inline_keyboard } };

  if (messageIdToEdit) {
    bot.editMessageText(text, { chat_id: chatId, message_id: messageIdToEdit, parse_mode: "HTML", reply_markup: options.reply_markup }).catch((err) => {
      bot.deleteMessage(chatId, messageIdToEdit).catch(()=>{});
      bot.sendMessage(chatId, text, options);
    });
  } else {
    bot.sendMessage(chatId, text, options);
  }
}

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminExists = await isAdmin(chatId);
  const payload = match[1];

  if (adminExists) {
    userStates[chatId] = null; // reset rejimni tozalaymiz
    if (payload && payload.startsWith("q_")) {
      const qId = parseInt(payload.split("_")[1]);
      if (!isNaN(qId)) {
        return await showQuestion(chatId, qId);
      }
    }
    
    const welcomeText = `👋 <b>Assalomu alaykum, Hurmatli Admin!</b>\n\nBotga xush kelibsiz. Bu yerda siz test savollariga ovozli tushuntirishlarni yuklashingiz va boshqarishingiz mumkin.\n\n👇 <i>Iltimos, pastdagi menyudan kerakli bo'limni tanlang yoki maxsus savolni topish uchun</i> <code>/search &lt;savol_id&gt;</code> <i>komandasidan foydalaning.</i>`;
    bot.sendMessage(chatId, welcomeText, { parse_mode: "HTML", ...mainMenuOptions });
  } else {
    const errorText = `⛔️ <b>KIRISH TAQIQLANGAN!</b>\n\nKechirasiz, sizda ushbu botdan foydalanish huquqi yo'q.\n\n🆔 <i>Sizning Chat ID raqamingiz:</i> <code>${chatId}</code>`;
    bot.sendMessage(chatId, errorText, { parse_mode: "HTML", reply_markup: { remove_keyboard: true } });
  }
});

bot.onText(/🔙 Bosh menyu/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) return;
  userStates[chatId] = null;
  bot.sendMessage(chatId, "🏠 <b>Bosh menyu</b>", { parse_mode: "HTML", ...mainMenuOptions });
});

bot.onText(/🌐 Til bo'yicha ovoz qo'shish/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) return;
  bot.sendMessage(chatId, "👇 <b>Qaysi til uchun ovozi yo'q savollarni ko'rmoqchisiz?</b>", { parse_mode: "HTML", ...langMenuOptions });
});

bot.onText(/🇺🇿 O'zbekcha/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) return;
  userStates[chatId] = { mode: "lang_filter", lang: "uz" };
  await sendQuestionsPage(chatId, 1, null, "uz");
});
bot.onText(/🇷🇺 Ruscha/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) return;
  userStates[chatId] = { mode: "lang_filter", lang: "ru" };
  await sendQuestionsPage(chatId, 1, null, "ru");
});
bot.onText(/🇺🇿 Kirillcha/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) return;
  userStates[chatId] = { mode: "lang_filter", lang: "kr" };
  await sendQuestionsPage(chatId, 1, null, "kr");
});

bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) return bot.sendMessage(chatId, "⛔️ <b>Siz admin emassiz.</b>", { parse_mode: "HTML" });
  userStates[chatId] = null; // reset
  await sendQuestionsPage(chatId, 1);
});

bot.onText(/📋 Savollar ro'yxati/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) return bot.sendMessage(chatId, "⛔️ <b>Siz admin emassiz.</b>", { parse_mode: "HTML" });
  userStates[chatId] = null; // reset
  await sendQuestionsPage(chatId, 1);
});

bot.onText(/📊 Statistika/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) return;

  const totalRes = await db("questions").count("id as count").first();
  const total = parseInt(totalRes.count) || 0;

  const uzRes = await db("questions").whereNotNull("audio_explanation_uz").count("id as count").first();
  const uzCount = parseInt(uzRes.count) || 0;

  const ruRes = await db("questions").whereNotNull("audio_explanation_ru").count("id as count").first();
  const ruCount = parseInt(ruRes.count) || 0;

  const krRes = await db("questions").whereNotNull("audio_explanation_kr").count("id as count").first();
  const krCount = parseInt(krRes.count) || 0;

  const text = `📊 <b>STATISTIKA BO'LIMI:</b>\n\n📝 <b>Umumiy savollar soni:</b> ${total} ta\n\n🇺🇿 O'zbek tilida ovoz kiritildi: <b>${uzCount} ta</b> (<i>${total - uzCount} ta qoldi</i>)\n🇷🇺 Rus tilida ovoz kiritildi: <b>${ruCount} ta</b> (<i>${total - ruCount} ta qoldi</i>)\n🇺🇿 Kirill tilida ovoz kiritildi: <b>${krCount} ta</b> (<i>${total - krCount} ta qoldi</i>)`;

  bot.sendMessage(chatId, text, { parse_mode: "HTML" });
});

bot.onText(/\/search (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) return bot.sendMessage(chatId, "⛔️ <b>Siz admin emassiz.</b>", { parse_mode: "HTML" });

  const questionId = parseInt(match[1]);
  if (isNaN(questionId))
    return bot.sendMessage(chatId, "⚠️ <b>ID faqat raqamlardan iborat bo'lishi kerak.</b>", { parse_mode: "HTML" });
  
  await showQuestion(chatId, questionId);
});

async function proceedToNext(chatId, state) {
  if (!state) return;
  const oldMode = state.mode;
  const oldLang = state.lang;
  
  if (oldMode === "lang_filter") {
    userStates[chatId] = { mode: oldMode, lang: oldLang }; // action recordingni o'chiramiz
    
    bot.sendMessage(chatId, "🔄 <i>Keyingi savol ro'yxati shakllantirilmoqda...</i>", { parse_mode: "HTML" }).then((waitMsg2) => {
      sendQuestionsPage(chatId, 1, waitMsg2.message_id, oldLang);
    });
  } else {
    userStates[chatId] = null;
  }
}

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  if (!(await isAdmin(chatId)))
    return bot.answerCallbackQuery(query.id, { text: "⛔️ Siz admin emassiz.", show_alert: true });

  const data = query.data;
  if (data.startsWith("record_")) {
    const parts = data.split("_");
    const qId = parseInt(parts[1]);
    const lang = parts[2];

    await triggerRecordingFlow(chatId, qId, lang);
    bot.answerCallbackQuery(query.id);
  } else if (data.startsWith("page_")) {
    const parts = data.split("_");
    const page = parseInt(parts[1]);
    const mode = parts[2] || "all";
    const filterLang = mode !== "all" ? mode : null;
    
    // Agar sahifa orqali ro'yxatga o'tsak, mode ni yangilash foydali bo'ladi
    if (filterLang) {
      userStates[chatId] = { mode: "lang_filter", lang: filterLang };
    } else {
      userStates[chatId] = null;
    }
    
    await sendQuestionsPage(chatId, page, query.message.message_id, filterLang);
    bot.answerCallbackQuery(query.id);
  } else if (data.startsWith("showq_")) {
    const qId = parseInt(data.split("_")[1]);
    await showQuestion(chatId, qId, query.message.message_id);
    bot.answerCallbackQuery(query.id);
  } else if (data.startsWith("copykr_")) {
    const qId = parseInt(data.split("_")[1]);
    const question = await db("questions").where({ id: qId }).first();
    if (question && question.audio_explanation_uz) {
      await db("questions").where({ id: qId }).update({ audio_explanation_kr: question.audio_explanation_uz });
      bot.answerCallbackQuery(query.id, { text: "✅ Kirillcha uchun ham saqlandi!", show_alert: false });
      bot.editMessageText(`✅ Kirillcha uchun ham saqlandi!`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: "HTML" }).catch(()=>{});
    } else {
      bot.answerCallbackQuery(query.id, { text: "❌ O'zbekcha ovoz topilmadi!", show_alert: true });
    }
    proceedToNext(chatId, userStates[chatId]);
  } else if (data.startsWith("skipkr_")) {
    bot.answerCallbackQuery(query.id);
    bot.deleteMessage(chatId, query.message.message_id).catch(()=>{});
    proceedToNext(chatId, userStates[chatId]);
  } else if (data.startsWith("delete_")) {
    const parts = data.split("_");
    const qId = parseInt(parts[1]);
    const lang = parts[2];
    const columnName = `audio_explanation_${lang}`;
    
    await db("questions").where({ id: qId }).update({ [columnName]: null });
    
    bot.answerCallbackQuery(query.id, { text: "✅ Ovoz muvaffaqiyatli o'chirildi!", show_alert: true });
    await showQuestion(chatId, qId, query.message.message_id);
  }
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  
  // Faqat voice va audio xabarlarni qabul qilamiz ushbu bo'limda
  if (!msg.voice && !msg.audio) return;
  
  const state = userStates[chatId];

  if (!state || state.action !== "recording") {
    return bot.sendMessage(
      chatId,
      "⚠️ <b>Iltimos, avval menyudan savolni toping va tilni tanlang.</b>",
      { parse_mode: "HTML" }
    );
  }

  try {
    const fileId = msg.voice ? msg.voice.file_id : msg.audio.file_id;
    const downloadPath = path.join(__dirname, "../backend/public/audio");

    if (!fs.existsSync(downloadPath)) {
      fs.mkdirSync(downloadPath, { recursive: true });
    }

    const waitMsg = await bot.sendMessage(chatId, "⏳ <i>Fayl serverga yuklanmoqda...</i>", { parse_mode: "HTML" });

    // Download file
    const downloadedFilePath = await bot.downloadFile(fileId, downloadPath);

    // Rename file
    const ext = path.extname(downloadedFilePath) || ".ogg";
    const fileName = `q${state.questionId}_${state.lang}_${Date.now()}${ext}`;
    const finalPath = path.join(downloadPath, fileName);

    fs.renameSync(downloadedFilePath, finalPath);

    // Update DB
    const columnName = `audio_explanation_${state.lang}`;
    await db("questions")
      .where({ id: state.questionId })
      .update({ [columnName]: `/public/audio/${fileName}` });

    bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
    
    bot.sendMessage(
      chatId, 
      `✅ <b>Ovozli tushuntirish muvaffaqiyatli saqlandi!</b>`,
      { parse_mode: "HTML" }
    );

    if (state.lang === "uz") {
      userStates[chatId] = { ...state, action: "waiting_kr_copy" };
      bot.sendMessage(
        chatId,
        `🤔 Ushbu ovozni <b>Kirillcha</b> (kr) versiyasi uchun ham saqlaysizmi?`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Ha, saqlansin", callback_data: `copykr_${state.questionId}` },
                { text: "❌ Yo'q", callback_data: `skipkr_${state.questionId}` }
              ]
            ]
          }
        }
      );
      return;
    }

    proceedToNext(chatId, state);
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "❌ <b>Xatolik yuz berdi:</b> " + err.message, { parse_mode: "HTML" });
  }
});

console.log("Telegram Audio Bot Module running on polling...");
