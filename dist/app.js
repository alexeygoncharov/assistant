import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import * as path from 'path';
import { config as _config } from "dotenv";
_config({ path: path.resolve(process.cwd(), 'config.env') }); // Import the .env file
let telegram_key = process.env.TELEGRAM_KEY;
import { Configuration, OpenAIApi } from "openai";
import { existsSync, mkdirSync, writeFile, unlink } from "fs";
import { schedule } from "node-cron";
import pkg from "sqlite3";
const { Database } = pkg;
const LIMIT = 500000; // Message limit - resets every midnight UTC
const TIMEOUT = 60; // TODO: Timeout in minutes
const MAX_TOKENS = 1000;
const TEMPERATURE = 0.7;
const MODEL = "text-davinci-003";
//const MODEL = "text-curie-001";
const DEFAULT_INTRO = `Вы - супер продвинутый ИИ. Вы разговариваете с человеком через интерфейс чата. Ваша задача - быть полезным, говорить с человеком вежливо и открыто. Не спрашивай в конце каждого сообщения можешь ли ты еще чем-то помочь.`;
// OpenAI API setup
const config = new Configuration({
    apiKey: process.env.OPENAI_KEY,
});
const openai = new OpenAIApi(config);
// Bot setup
const bot = new Telegraf(telegram_key);
// Database setup
const db = new Database("./users.db");
//Needle
import needle from "needle";
import { URLSearchParams } from "url";
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (user_id INTEGER, chat_messages TEXT, intro TEXT, message_count INTEGER, date DATETIME)");
    // Create the log table
    db.run("CREATE TABLE IF NOT EXISTS log (user_id INTEGER, message TEXT, intro TEXT, date DATETIME)");
    // Create a trigger that logs the chat history when a user is deleted
    db.run("CREATE TRIGGER IF NOT EXISTS log_chat_history AFTER DELETE ON users BEGIN INSERT INTO log (user_id, message, intro, date) VALUES (old.user_id, old.chat_messages, old.intro, old.date); END");
});
// Update the slash commands
bot.telegram.setMyCommands([
    {
        command: "/start",
        description: "Посмотреть инструкцию по использованию",
    },
    { command: "/help", description: "Показать это сообщение" },
    { command: "/info", description: "Показать инфо о боте" },
    { command: "/ask", description: "Спросить что-то у бота" },
    { command: "/reset", description: "Сбросить чат" },
    {
        command: "/limit",
        description: "Посмотреть, сколько сообщений боту у вас осталось (лимит сбрасывается ежедневно в 00:00",
    },
    { command: "/intro", description: "Show or change the intro message" },
    { command: "/save", description: "Save the conversation to a txt file" },
]);
// Start command
bot.command("start", async (ctx) => {
    const start_text = `Чтобы начать - просто отправьте мне ваш вопрос ОДНИМ СООБЩЕНИЕМ.`;
    ctx.replyWithMarkdown(start_text);
});
// Help command
bot.command("help", async (ctx) => {
    const help_text = `*Commands:*\n/start - Show instructions on how to use the bot\n/help - Show this message\n/info - Show info about the bot\n/ask - Ask the bot a question\n/reset - Reset the chatbot\n/limit - Show how many messages you have left (message limit resets every midnight UTC)\n/intro - Show, change or reset the intro message\n/save - Save the conversation to a txt file`;
    ctx.replyWithMarkdown(help_text);
});
bot.command("info", async (ctx) => {
    // List the constants
    const info_text = `*Лимит сообщений:* \`${LIMIT}\` в день\n*Модель:* \`${MODEL}\`\n*Кол-во токенов:* \`${MAX_TOKENS}\`\n*Температура:* \`${TEMPERATURE}\``;
    ctx.replyWithMarkdown(info_text);
});
bot.command("reset", async (ctx) => {
    // Get users ID
    const user_id = ctx.message.from.id;
    // Get current time
    const date = new Date().toISOString().slice(0, 19).replace("T", " ");
    // If the user exists in the database, fetch his message count and store it in a variable. Delete the user from the database and insert a new user with the same ID and the same message count.
    db.get(`SELECT * FROM users WHERE user_id = ${user_id}`, (err, row) => {
        if (err) {
            ctx.replyWithMarkdown(`An error has occured: \`${err}\``);
        }
        else {
            if (row) {
                const message_count = row.message_count;
                // Save the intro if it is not the default intro
                db.run("DELETE FROM users WHERE user_id = ?", [user_id]);
                // If the intro was changed, make sure to save it
                if (row.intro !== DEFAULT_INTRO) {
                    db.run("INSERT INTO users (user_id, chat_messages, intro, message_count, date) VALUES (?, ?, ?, ?, ?)", [user_id, "", row.intro, message_count, date]);
                }
                else {
                    db.run("INSERT INTO users (user_id, chat_messages, intro, message_count, date) VALUES (?, ?, ?, ?, ?)", [user_id, "", DEFAULT_INTRO, message_count, date]);
                }
                ctx.reply("Chat history reset! Your message count has not been reset.");
            }
            else {
                ctx.reply("You have not started a conversation yet!");
            }
        }
    });
});
bot.command("limit", async (ctx) => {
    // Get users ID
    const user_id = ctx.message.from.id;
    // Get the users message count from the database
    db.get("SELECT * FROM users WHERE user_id = ?", [user_id], (err, row) => {
        if (err) {
            ctx.replyWithMarkdown(`An error has occured: \`${err}\``);
        }
        else {
            if (row) {
                const message_count = row.message_count;
                if (message_count < LIMIT) {
                    ctx.replyWithMarkdown(`У вас осталось \`${LIMIT - message_count}\` сообщений.`);
                }
                else {
                    ctx.replyWithMarkdown(`You have reached the message limit of \`${LIMIT}\` messages. Please wait until midnight UTC to send more messages.`);
                }
            }
            else {
                ctx.reply("You have not started a conversation yet!");
            }
        }
    });
});
bot.command("save", async (ctx) => {
    // Get users ID
    const user_id = ctx.message.from.id;
    // Get the users messages from the database
    db.get(`SELECT * FROM users WHERE user_id = ${user_id}`, (err, row) => {
        if (err) {
            ctx.reply(`An error has occured: ${err}`);
            return;
        }
        if (!row) {
            ctx.reply("You have not started a conversation yet!");
            return;
        }
        const CHAT_MESSAGES = row.chat_messages;
        // Create a file with the users messages
        // Be sure that the saves folder exists do it asynchronously
        if (!existsSync("./saves")) {
            mkdirSync("./saves");
        }
        writeFile(`./saves/${user_id}.txt`, CHAT_MESSAGES, "utf8", (error) => {
            if (error) {
                ctx.replyWithMarkdown(`An error has occured: \`${err}\``);
                return;
            }
            // Send the file to the user with a message
            ctx.replyWithDocument({ source: `./saves/${user_id}.txt` }, { caption: "Here is our chat history so far" });
            // Delete the file after 1 minute
            setTimeout(() => {
                unlink(`./saves/${user_id}.txt`, (errorr) => {
                    if (errorr) {
                        ctx.replyWithMarkdown(`An error has occured: \`${errorr}\``);
                    }
                });
            }, 1 * 60 * 1000);
        });
    });
});
bot.command("ask", async (ctx) => {
    // Get users ID
    const user_id = ctx.message.from.id;
    // Check if the user exists in the database
    db.get(`SELECT * FROM users WHERE user_id = ${user_id}`, async (err, row) => {
        if (err) {
            ctx.replyWithMarkdown(`An error has occured: \`${err}\``);
        }
        else {
            let message_count = 0;
            if (row) {
                message_count = row.message_count;
            }
            else {
                // Create a new user in the database
                const date = new Date()
                    .toISOString()
                    .slice(0, 19)
                    .replace("T", " ");
                message_count = 0;
                db.run(
                // Insert with the intro
                "INSERT INTO users (user_id, chat_messages, intro, message_count, date) VALUES (?, ?, ?, ?, ?)", [user_id, "", DEFAULT_INTRO, message_count, date]);
            }
            // If the user has not reached the message limit, send the message to OpenAI and send the response back to the user
            if (message_count < LIMIT) {
                // Get the users message
                const message = ctx.message.text
                    .split(" ")
                    .slice(1)
                    .join(" ");
                // If the message is empty, send a message to the user
                if (message === "") {
                    ctx.reply("Please enter a message!");
                    return;
                }
                // Format the request to OpenAI
                const request = `Вы - супер продвинутый ИИ. Вы разговариваете с человеком через интерфейс чата. Ваша задача - быть полезным, говорить с человеком вежливо и открыто.\nЧеловек: ${message}\nИИ:`;
                // Send the message to OpenAI
                ctx.sendChatAction("typing");
                const response = await openai.createCompletion({
                    model: MODEL,
                    prompt: request,
                    temperature: TEMPERATURE,
                    max_tokens: MAX_TOKENS,
                    stop: ["\nЧеловек:", "\nИИ:"],
                });
                // Send the response to the user
                const reply = response.data.choices[0].text;
                ctx.reply(reply);
                // Update the users message count in the database
                db.run("UPDATE users SET message_count = message_count + 1 WHERE user_id = ?", [user_id]);
            }
            else {
                ctx.replyWithMarkdown(`You have reached the message limit of \`${LIMIT}\` messages. Please wait until midnight UTC to send more messages.`);
            }
        }
    });
});
bot.command("intro", async (ctx) => {
    // If the message is empty, send a message to the user with his current intro. If not, update the intro in the database and send a message to the user with the new intro.
    // Get users ID
    const user_id = ctx.message.from.id;
    // Check if the user exists in the database
    db.get("SELECT * FROM users WHERE user_id = ?", [user_id], (err, row) => {
        if (err) {
            ctx.replyWithMarkdown(`An error has occured: \`${err}\``);
            return;
        }
        // Check if the user wanted to reset his intro by sending /intro reset or /intro default or /intro none or /intro clear
        let intro = "";
        if (ctx.message.text.split(" ").slice(1).join(" ") === "reset" ||
            ctx.message.text.split(" ").slice(1).join(" ") === "default" ||
            ctx.message.text.split(" ").slice(1).join(" ") === "none" ||
            ctx.message.text.split(" ").slice(1).join(" ") === "clear") {
            intro = DEFAULT_INTRO;
        }
        else {
            // Check if the user even sent an intro
            if (ctx.message.text.split(" ").slice(1).join(" ") === "") {
                intro = "";
            }
            else {
                // Get the users intro
                intro = ctx.message.text.split(" ").slice(1).join(" ");
            }
        }
        // If the user sent no intro, send a message to the user with his current intro
        if (intro === "") {
            // Check if the user has an intro
            ctx.replyWithMarkdown(`Your intro is: \`${row.intro}\``);
            return;
        }
        // Update the users intro in the database
        db.run("UPDATE users SET intro = ? WHERE user_id = ?", [
            intro,
            user_id,
        ]);
        // Send the intro to the user
        ctx.replyWithMarkdown(`Your intro has been set to:\n\`${intro}\``);
    });
});
function randomVoiceFilename(length = 32) {
    let result = '';
    const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    let counter = 0;
    while (counter < length) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
        counter += 1;
    }
    return result + '.ogg';
}
function processMessage(ctx, messageText, replyType) {
    // Check if the message is from a group chat
    if (ctx.message.chat.type === "group" ||
        ctx.message.chat.type === "supergroup") {
        return;
    }
    // Get users ID
    const user_id = ctx.message.from.id;
    // Get the users message count from the database
    // Check if the user exists in the database
    db.get(`SELECT * FROM users WHERE user_id = ${user_id}`, async (err, row) => {
        if (err) {
            if (replyType === 'audio')
                audioReply(ctx, "Произошла ошибка");
            else
                ctx.replyWithMarkdown(`Произошла ошибка: \`${err}\``);
            return;
        }
        let message_count = 0;
        let chat_messages = "";
        let intro = "";
        if (row) {
            // Get his info from the database
            message_count = row.message_count;
            chat_messages = row.chat_messages;
            intro = row.intro;
        }
        else {
            // Create a new user in the database
            const date = new Date()
                .toISOString()
                .slice(0, 19)
                .replace("T", " ");
            message_count = 0;
            chat_messages = "";
            db.run("INSERT INTO users (user_id, chat_messages, intro, message_count, date) VALUES (?, ?, ?, ?, ?)", [user_id, chat_messages, DEFAULT_INTRO, message_count, date]);
        }
        // Check if the user has reached the message limit
        if (message_count > LIMIT) {
            if (replyType === 'audio')
                audioReply(ctx, "Достигнут лимит сообщений. Лимит будет возобновлен после полуночи");
            else
                ctx.replyWithMarkdown(`You have reached the message limit of \`${LIMIT}\` messages. Please wait until midnight UTC to send more messages.`);
            return;
        }
        // Get the users message
        //const message: string = ctx.message.text;
        const message = messageText;
        // If the message is empty, send a message to the user
        if (message.trim() === "") {
            if (replyType === 'audio')
                audioReply(ctx, "Отправьте не пустое сообщение! Скажите что-нибудь!");
            else
                ctx.replyWithMarkdown("Отправьте не пустое сообщение! Скажите что-нибудь!");
            return;
        }
        // Format the request to OpenAI (if the user is new, send a intro message too)
        let request = "";
        // If the user has a custom intro, use that. If not, use the default intro. Also if the user has sent messages before, add them to the request. If not, do not add them to the request.
        if (chat_messages === "") {
            request = `${intro}\nHuman: ${message}\nAI:`;
        }
        else {
            request = `${intro}\n${chat_messages}\nHuman: ${message}\nAI:`;
        }
        // Send a typing action to the user
        ctx.sendChatAction("typing");
        // Send the message to OpenAI
        // For debugging purposes, print the request to the console
        // console.log(`===\n${request}\n===`);
        let response = null;
        try {
            response = await openai.createCompletion({
                model: MODEL,
                prompt: request,
                temperature: TEMPERATURE,
                max_tokens: MAX_TOKENS,
                stop: ["\nHuman:", "\nAI:"],
            });
        }
        catch (exception) {
            console.warn('openai exception');
        }
        // Send the response back to the user
        if (response === null) {
            if (replyType === 'audio')
                audioReply(ctx, "Не расслышал вас, повторите пожалуйста снова!");
            else
                ctx.replyWithMarkdown("Не расслышал вас, повторите пожалуйста снова!");
            return;
        }
        let reply = response.data.choices[0].text;
        // If the reply is empty, send a default message
        if (reply === "") {
            reply = "Я не знаю что сказать.";
        }
        // Trim the whitespaces
        if (reply == undefined) {
            reply = "Я не знаю что сказать.";
        }
        reply = reply.trim();
        // Change the " to ' to prevent errors
        reply = reply.replace(/"/g, "'");
        if (replyType === 'audio')
            audioReply(ctx, reply);
        else
            ctx.reply(reply);
        db.run("UPDATE users SET message_count = message_count + 1 WHERE user_id = ?", [user_id]);
        // Add a whitespace to the beginning of the reply to make it look better
        reply = ` ${reply}`;
        let new_chat_messages = "";
        // If the user is new, add the intro message
        if (chat_messages === "") {
            new_chat_messages = `${intro}\nHuman: ${message}\nAI:${reply}`;
        }
        else {
            new_chat_messages = `${chat_messages}\nHuman: ${message}\nAI:${reply}`;
        }
        db.run("UPDATE users SET chat_messages = ? WHERE user_id = ?", [
            new_chat_messages,
            user_id,
        ]);
    });
}
function audioReply(ctx, messageText) {
    let ttsParams = new URLSearchParams();
    ttsParams.append('text', messageText);
    ttsParams.append('folderId', process.env.YANDEX_API_FOLDER_ID);
    ttsParams.append('lang', 'ru-RU');
    ttsParams.append('voice', 'filipp');
    needle.post('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', ttsParams.toString(), {
        headers: {
            'Authorization': 'Api-Key ' + process.env.YANDEX_API_KEY
        }
    }, function (speech_error, speech_response, speech_body) {
        if (!speech_error) {
            console.log('synthesized', speech_body);
            ctx.telegram.sendDocument(ctx.from.id, {
                source: speech_body,
                filename: randomVoiceFilename()
            });
        }
    });
}
function processAudioFile(ctx, file_id) {
    needle.get('https://api.telegram.org/bot' + process.env.TELEGRAM_KEY + '/getFile?file_id=' + file_id, function (error, response, body) {
        console.log('telega download file: ' + response.statusCode);
        if (!error && response.statusCode == 200) {
            let fileURL = 'https://api.telegram.org/file/bot' + process.env.TELEGRAM_KEY + '/' + body.result.file_path;
            var fileStream = needle.get(fileURL);
            needle.post('https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?topic=general&folderId=' + process.env.YANDEX_API_FOLDER_ID, fileStream, {
                headers: {
                    'Authorization': 'Api-Key ' + process.env.YANDEX_API_KEY
                }
            }, function (speech_error, speech_response, speech_body) {
                console.log('reabodu');
                if (speech_error) {
                    console.log('recog error', speech_error);
                    audioReply(ctx, "Не расслышала вас, повторите пожалуйста снова!");
                    return;
                }
                else {
                    if (typeof speech_body.result === 'string') {
                        console.log('recog ok: ', speech_body.result);
                        processMessage(ctx, speech_body.result, 'audio');
                    }
                    else {
                        console.log('recog not ok', speech_body);
                        audioReply(ctx, "Не расслышала вас, повторите пожалуйста снова!");
                        return;
                    }
                }
            });
        }
        else {
            console.log('audio download error!', error, response.statusCode);
            audioReply(ctx, "Не расслышала вас, повторите пожалуйста снова!");
            return;
        }
    });
}
// On every message sent (except in a group chat)
bot.on(message("text"), async (ctx) => {
    processMessage(ctx, ctx.message.text, 'text');
});
bot.on(message("audio"), async (ctx) => {
    console.log('audio: ', ctx);
    console.log('audio message:', ctx.message);
    console.log('telega downloading file: ' + ctx.message.audio.file_id);
    processAudioFile(ctx, ctx.message.audio.file_id);
});
bot.on(message("voice"), async (ctx) => {
    console.log('voice ctx: ', ctx);
    console.log('voice message:', ctx.message);
    console.log('telega downloading file: ' + ctx.message.voice.file_id);
    processAudioFile(ctx, ctx.message.voice.file_id);
});
// Every day at 23:00 (UTC time in Polish timezone) reset the message count for all users
schedule("0 23 * * *", () => {
    db.run(`UPDATE users SET message_count = 0`);
    // Get the count of users in the database
    db.get(`SELECT COUNT(*) FROM users`, (err, row) => {
        if (err) {
            console.log(`An error has occured: ${err}`);
            return;
        }
        console.log(`Reset message count for ${row["COUNT(*)"]} users.`);
    });
});
console.log(`Bot started.`);
// Launch the bot
bot.launch();
// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
//# sourceMappingURL=app.js.map