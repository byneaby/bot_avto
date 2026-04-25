const { Telegraf } = require("telegraf");
const puppeteer = require("puppeteer");
const fs = require("fs");

const BOT_TOKEN = "8296160712:AAGuvEE0ecucjUg3OftTPpPhTZecIYpifYo";
const LOGIN_URL = "https://avtomektep.kz/auth/login";
const API_URL = "https://api.avtomektep.kz/students/my";
const ACCOUNT_URL = "https://api.avtomektep.kz/account";

// =====================
// ⚙️ КОНФИГ (сохраняется в файл)
// =====================
const CONFIG_FILE = "/tmp/config.json";
const USERS_FILE = "/tmp/users.json";

function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch {
        return {
            adminId: null,
            isPaid: false,
            contactUsername: "",
            contactText: "Напишите нам для получения доступа!"
        };
    }
}

function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function loadUsers() {
    try {
        return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    } catch {
        return { approved: [], requests: [] };
    }
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

let config = loadConfig();
let users = loadUsers();

const bot = new Telegraf(BOT_TOKEN);

// =====================
// 💾 MEMORY STORE
// =====================
const sessions = {};
const loginJobs = {};
const adminState = {};

// =====================
// 🎛 МЕНЮ
// =====================
const mainMenu = {
    reply_markup: {
        keyboard: [
            [{ text: "🔐 Войти через QR" }],
            [{ text: "📊 Информация об обучении" }]
        ],
        resize_keyboard: true
    }
};

const adminMenu = {
    reply_markup: {
        keyboard: [
            [{ text: "📋 Запросы на доступ" }],
            [{ text: "👥 Пользователи с доступом" }],
            [{ text: "📞 Настройка контакта" }],
            [{ text: "💰 Режим оплаты" }],
            [{ text: "🏠 Выйти из админки" }]
        ],
        resize_keyboard: true
    }
};

// =====================
// 🔐 ПРОВЕРКА ДОСТУПА
// =====================
function hasAccess(chatId) {
    if (!config.isPaid) return true;
    return users.approved.includes(String(chatId));
}

function isAdmin(chatId) {
    return String(chatId) === String(config.adminId);
}

// =====================
// 🔐 ПРОВЕРКА ВХОДА
// =====================
async function isLogged(page) {
    try {
        return !page.url().includes("auth/login");
    } catch {
        return false;
    }
}

// =====================
// 📊 ПОЛУЧЕНИЕ ДАННЫХ
// =====================
async function getCookieHeader(chatId) {
    const cookies = sessions[chatId];
    if (!cookies) return null;
    return cookies.map(c => `${c.name}=${c.value}`).join("; ");
}

async function getAccount(chatId) {
    const cookieHeader = await getCookieHeader(chatId);
    if (!cookieHeader) return null;
    const res = await fetch(ACCOUNT_URL, { headers: { Cookie: cookieHeader } });
    return await res.json();
}

async function getStudent(chatId) {
    const cookieHeader = await getCookieHeader(chatId);
    if (!cookieHeader) return null;
    const res = await fetch(API_URL, { headers: { Cookie: cookieHeader } });
    return await res.json();
}

// =====================
// 🔐 ЛОГИН
// =====================
async function stopLogin(chatId) {
    if (loginJobs[chatId]) {
        clearInterval(loginJobs[chatId].interval);
        try { await loginJobs[chatId].browser.close(); } catch(e) {}
        delete loginJobs[chatId];
    }
}

async function handleLogin(ctx) {
    const chatId = ctx.chat.id;

    // Проверка доступа
    if (!hasAccess(chatId)) {
        const contactText = config.contactUsername
            ? `👤 Напишите: @${config.contactUsername}`
            : config.contactText;
        return ctx.reply(
            `🔒 Доступ к боту платный.\n\n${contactText}\n\nПосле оплаты вам будет выдан доступ.`,
            {
                reply_markup: {
                    keyboard: [[{ text: "📩 Запросить доступ" }]],
                    resize_keyboard: true
                }
            }
        );
    }

    if (loginJobs[chatId]) {
        await stopLogin(chatId);
        await ctx.reply("🔄 Предыдущий сеанс отменён, запускаю новый QR...");
    }

    await ctx.reply("🔐 Открываю страницу входа, подождите...");

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const page = await browser.newPage();

    try {
        await page.goto(LOGIN_URL);
        await new Promise(r => setTimeout(r, 5000));

        const qrPath = `/tmp/qr_${chatId}.png`;

        try {
            await page.waitForSelector('.css-1yjvs5a svg', { timeout: 15000 });
            await new Promise(r => setTimeout(r, 1000));
            const qrBlock = await page.$('.css-1yjvs5a');
            await qrBlock.screenshot({ path: qrPath });
        } catch(e) {
            await page.screenshot({ path: qrPath, fullPage: true });
        }

        // ✅ Получаем session_id из cookies страницы
        const pageCookies = await page.cookies();
        const sessionCookie = pageCookies.find(c => c.name === 'session_id');

        let inlineKeyboard = null;
        if (sessionCookie) {
            const mgovUrl = `https://api.avtomektep.kz/mgovSign?id=${sessionCookie.value}&type=AUTHORIZE`;
            const egovLink = `https://m.egov.kz/mobileSign/?link=${encodeURIComponent(mgovUrl)}`;
            inlineKeyboard = {
                reply_markup: {
                    inline_keyboard: [[
                        { text: "📲 Открыть eGov Mobile", url: egovLink }
                    ]]
                }
            };
        }

        const caption = "📱 Отсканируйте QR через приложение eGov\n\n" +
            (inlineKeyboard ? "👆 Или нажмите кнопку ниже — откроется eGov прямо на телефоне\n\n" : "") +
            "⏳ Бот автоматически определит вход...";

        await ctx.replyWithPhoto(
            { source: qrPath },
            {
                caption,
                ...(inlineKeyboard || {})
            }
        );

    } catch(e) {
        await browser.close().catch(() => {});
        return ctx.reply("❌ Не удалось загрузить страницу входа. Попробуйте снова.", mainMenu);
    }

    const interval = setInterval(async () => {
        try {
            const logged = await isLogged(page);
            if (logged) {
                clearInterval(loginJobs[chatId].interval);
                delete loginJobs[chatId];
                const cookies = await page.cookies();
                sessions[chatId] = cookies;
                await browser.close();
                await ctx.reply("✅ Вы успешно вошли! Загружаю информацию...", mainMenu);
                await handleInfo(ctx);
            }
        } catch (e) {
            clearInterval(loginJobs[chatId]?.interval);
            delete loginJobs[chatId];
            await browser.close().catch(() => {});
            await ctx.reply("❌ Ошибка при входе. Попробуйте снова.", mainMenu);
        }
    }, 4000);

    loginJobs[chatId] = { interval, browser };
}

// =====================
// 📊 ИНФОРМАЦИЯ
// =====================
async function handleInfo(ctx) {
    const chatId = ctx.chat.id;

    if (!hasAccess(chatId)) {
        const contactText = config.contactUsername
            ? `👤 Напишите: @${config.contactUsername}`
            : config.contactText;
        return ctx.reply(
            `🔒 Доступ к боту платный.\n\n${contactText}`,
            {
                reply_markup: {
                    keyboard: [[{ text: "📩 Запросить доступ" }]],
                    resize_keyboard: true
                }
            }
        );
    }

    const [data, accountData] = await Promise.all([getStudent(chatId), getAccount(chatId)]);

    if (!data?.items?.[0]) {
        return ctx.reply("❌ Нет данных. Сначала войдите через кнопку 🔐 Войти через QR", mainMenu);
    }

    const item = data.items[0];
    const school = item.group.school;
    const group = item.group;
    const acc = school?.data?.accountingData || {};
    const cert = item.data || {};
    const user = accountData?.user || {};
    const fullName = [user.lastName, user.firstName, user.patronymic].filter(Boolean).join(" ") || "Нет данных";
    const phone = user.phone ? `+${user.phone}` : "Нет данных";
    const iin = user.iin || "Нет данных";

    const msg =
`📊 <b>ИНФОРМАЦИЯ ОБ ОБУЧЕНИИ</b>

👤 <b>Личные данные</b>
ФИО: ${fullName}
📞 Телефон: ${phone}
🪪 ИИН: ${iin}

🏫 <b>Учебная организация</b>
${school.title}
📍 ${school.address}
📞 ${school.phone1}

📚 <b>Категория обучения</b>
${group.categoryId}

👥 <b>Учебная группа</b>
${group.title}

📅 <b>Период обучения</b>
${group.startDate} → ${group.endDate}

📌 <b>Статус обучения</b>
${item.passed ? "✅ Пройден" : "⏳ В процессе"}

🧾 <b>Сертификат</b>
Номер: ${cert.certificateNumber || "Нет данных"}

📊 <b>Оценки</b>
Теория: ${item.rules}
Практика: ${item.practice}
Обслуживание: ${item.maintenance}

🏦 <b>Банк (школа)</b>
БИК: ${acc.bik || "-"}
IBAN: ${acc.iban || "-"}
Банк: ${acc.receiver_bank || "-"}
Контакт: ${acc.contact_name || "-"}
Тел: ${acc.contact_phone || "-"}`;

    await ctx.reply(msg, { parse_mode: "HTML", ...mainMenu });
}

// =====================
// 🚀 СТАРТ
// =====================
bot.start(async (ctx) => {
    const chatId = ctx.chat.id;

    if (!config.adminId) {
        config.adminId = String(chatId);
        saveConfig(config);
        return ctx.reply(
            "👑 Вы назначены администратором бота!\n\nИспользуйте /admin для управления.",
            mainMenu
        );
    }

    await ctx.reply(
        "👋 Добро пожаловать!\n\n📱 Этот бот показывает информацию об обучении в автошколе.\n\nВыберите действие:",
        mainMenu
    );
});

// =====================
// 👑 АДМИН ПАНЕЛЬ
// =====================
bot.command("admin", async (ctx) => {
    const chatId = ctx.chat.id;
    if (!isAdmin(chatId)) return ctx.reply("❌ У вас нет доступа к админ панели.");
    await ctx.reply("👑 Добро пожаловать в админ панель!", adminMenu);
});

// Запросы на доступ
bot.hears("📋 Запросы на доступ", async (ctx) => {
    if (!isAdmin(ctx.chat.id)) return;
    users = loadUsers();

    if (users.requests.length === 0) {
        return ctx.reply("📭 Нет новых запросов.", adminMenu);
    }

    for (const req of users.requests) {
        await ctx.reply(
            `📩 <b>Запрос на доступ</b>\n\nID: <code>${req.id}</code>\nИмя: ${req.name}\nUsername: ${req.username ? "@" + req.username : "нет"}\nДата: ${req.date}`,
            {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [[
                        { text: "✅ Выдать доступ", callback_data: `approve_${req.id}` },
                        { text: "❌ Отклонить", callback_data: `reject_${req.id}` }
                    ]]
                }
            }
        );
    }
});

// Пользователи с доступом
bot.hears("👥 Пользователи с доступом", async (ctx) => {
    if (!isAdmin(ctx.chat.id)) return;
    users = loadUsers();

    if (users.approved.length === 0) {
        return ctx.reply("📭 Нет пользователей с доступом.", adminMenu);
    }

    const list = users.approved.map((id, i) => `${i + 1}. <code>${id}</code>`).join("\n");
    await ctx.reply(`👥 <b>Пользователи с доступом:</b>\n\n${list}`, { parse_mode: "HTML", ...adminMenu });
});

// Настройка контакта
bot.hears("📞 Настройка контакта", async (ctx) => {
    if (!isAdmin(ctx.chat.id)) return;
    adminState[ctx.chat.id] = "waiting_contact";
    await ctx.reply(
`📞 <b>Текущие настройки контакта:</b>
Username: ${config.contactUsername ? "@" + config.contactUsername : "не задан"}
Текст: ${config.contactText}

Выберите что изменить:`,
        {
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "👤 Изменить @username", callback_data: "set_username" }],
                    [{ text: "📝 Изменить текст сообщения", callback_data: "set_contact_text" }]
                ]
            }
        }
    );
});

// Режим оплаты
bot.hears("💰 Режим оплаты", async (ctx) => {
    if (!isAdmin(ctx.chat.id)) return;
    await ctx.reply(
        `💰 <b>Текущий режим:</b> ${config.isPaid ? "🔒 Платный" : "🔓 Бесплатный"}\n\nВыберите режим:`,
        {
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [[
                    { text: "🔓 Бесплатный", callback_data: "mode_free" },
                    { text: "🔒 Платный", callback_data: "mode_paid" }
                ]]
            }
        }
    );
});

// Выйти из админки
bot.hears("🏠 Выйти из админки", async (ctx) => {
    if (!isAdmin(ctx.chat.id)) return;
    await ctx.reply("👋 Вы вышли из админ панели.", mainMenu);
});

// =====================
// 📩 ЗАПРОС ДОСТУПА
// =====================
bot.hears("📩 Запросить доступ", async (ctx) => {
    const chatId = String(ctx.chat.id);
    users = loadUsers();

    if (users.approved.includes(chatId)) {
        return ctx.reply("✅ У вас уже есть доступ!", mainMenu);
    }

    if (users.requests.find(r => r.id === chatId)) {
        return ctx.reply("⏳ Ваш запрос уже отправлен. Ожидайте подтверждения.");
    }

    const from = ctx.from;
    users.requests.push({
        id: chatId,
        name: [from.first_name, from.last_name].filter(Boolean).join(" "),
        username: from.username || "",
        date: new Date().toLocaleString("ru-RU")
    });
    saveUsers(users);

    if (config.adminId) {
        await bot.telegram.sendMessage(
            config.adminId,
            `📩 <b>Новый запрос на доступ!</b>\n\nИмя: ${[from.first_name, from.last_name].filter(Boolean).join(" ")}\nUsername: ${from.username ? "@" + from.username : "нет"}\nID: <code>${chatId}</code>\n\nОткройте /admin → Запросы на доступ`,
            { parse_mode: "HTML" }
        );
    }

    await ctx.reply("✅ Ваш запрос отправлен!\n\nАдминистратор рассмотрит его в ближайшее время.");
});

// =====================
// 🎛 CALLBACK КНОПКИ
// =====================
bot.action("set_username", async (ctx) => {
    if (!isAdmin(ctx.chat.id)) return;
    adminState[ctx.chat.id] = "waiting_username";
    await ctx.editMessageText(
        `👤 Текущий username: ${config.contactUsername ? "@" + config.contactUsername : "не задан"}\n\nОтправьте новый @username (без @):`
    );
});

bot.action("set_contact_text", async (ctx) => {
    if (!isAdmin(ctx.chat.id)) return;
    adminState[ctx.chat.id] = "waiting_text";
    await ctx.editMessageText(
        `📝 Текущий текст:\n${config.contactText}\n\nОтправьте новый текст сообщения для пользователей без доступа:`
    );
});

// Обработка текстового ввода от админа
bot.on("text", async (ctx, next) => {
    const chatId = ctx.chat.id;
    const state = adminState[chatId];

    if (!isAdmin(chatId) || !state) return next();

    const text = ctx.message.text;

    const menuPrefixes = ["📋","👥","📞","💰","🏠","🔐","📊","📩"];
    if (menuPrefixes.some(p => text.startsWith(p))) return next();

    if (state === "waiting_username") {
        config.contactUsername = text.replace("@", "").trim();
        saveConfig(config);
        delete adminState[chatId];
        await ctx.reply(`✅ Username обновлён: @${config.contactUsername}`, adminMenu);
    } else if (state === "waiting_text") {
        config.contactText = text.trim();
        saveConfig(config);
        delete adminState[chatId];
        await ctx.reply(`✅ Текст обновлён:\n${config.contactText}`, adminMenu);
    } else {
        return next();
    }
});

bot.action(/approve_(.+)/, async (ctx) => {
    if (!isAdmin(ctx.chat.id)) return;
    const userId = ctx.match[1];
    users = loadUsers();

    if (!users.approved.includes(userId)) {
        users.approved.push(userId);
    }
    users.requests = users.requests.filter(r => r.id !== userId);
    saveUsers(users);

    await ctx.editMessageText(`✅ Доступ выдан пользователю ${userId}`);

    try {
        await bot.telegram.sendMessage(userId, "🎉 Вам выдан доступ к боту!\n\nТеперь вы можете пользоваться всеми функциями.", mainMenu);
    } catch(e) {}
});

bot.action(/reject_(.+)/, async (ctx) => {
    if (!isAdmin(ctx.chat.id)) return;
    const userId = ctx.match[1];
    users = loadUsers();
    users.requests = users.requests.filter(r => r.id !== userId);
    saveUsers(users);

    await ctx.editMessageText(`❌ Запрос пользователя ${userId} отклонён`);

    try {
        await bot.telegram.sendMessage(userId, "❌ Ваш запрос на доступ отклонён.\n\nЕсли есть вопросы — обратитесь к администратору.");
    } catch(e) {}
});

bot.action("mode_free", async (ctx) => {
    if (!isAdmin(ctx.chat.id)) return;
    config.isPaid = false;
    saveConfig(config);
    await ctx.editMessageText("✅ Режим изменён: 🔓 Бесплатный — все пользователи имеют доступ.");
});

bot.action("mode_paid", async (ctx) => {
    if (!isAdmin(ctx.chat.id)) return;
    config.isPaid = true;
    saveConfig(config);
    await ctx.editMessageText("✅ Режим изменён: 🔒 Платный — только одобренные пользователи имеют доступ.");
});

// =====================
// 🎛 ОБРАБОТЧИКИ КНОПОК
// =====================
bot.hears("🔐 Войти через QR", handleLogin);
bot.hears("📊 Информация об обучении", handleInfo);
bot.command("login", handleLogin);
bot.command("info", handleInfo);

// Команда выдачи доступа вручную
bot.command("approve", async (ctx) => {
    if (!isAdmin(ctx.chat.id)) return;
    const userId = ctx.message.text.split(" ")[1];
    if (!userId) return ctx.reply("Использование: /approve USER_ID");

    users = loadUsers();
    if (!users.approved.includes(userId)) users.approved.push(userId);
    users.requests = users.requests.filter(r => r.id !== userId);
    saveUsers(users);

    await ctx.reply(`✅ Доступ выдан: ${userId}`);
    try {
        await bot.telegram.sendMessage(userId, "🎉 Вам выдан доступ к боту!\n\nТеперь вы можете пользоваться всеми функциями.", mainMenu);
    } catch(e) {}
});

// Команда отзыва доступа
bot.command("revoke", async (ctx) => {
    if (!isAdmin(ctx.chat.id)) return;
    const userId = ctx.message.text.split(" ")[1];
    if (!userId) return ctx.reply("Использование: /revoke USER_ID");

    users = loadUsers();
    users.approved = users.approved.filter(id => id !== userId);
    saveUsers(users);

    await ctx.reply(`✅ Доступ отозван: ${userId}`);
});

// =====================
bot.launch();
console.log("🚀 BOT RUNNING");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
