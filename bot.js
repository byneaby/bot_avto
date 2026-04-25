const { Telegraf } = require("telegraf");
const { chromium } = require("playwright");

const BOT_TOKEN = "8296160712:AAGuvEE0ecucjUg3OftTPpPhTZecIYpifYo";
const LOGIN_URL = "https://avtomektep.kz/auth/login";
const API_URL = "https://api.avtomektep.kz/students/my";
const ACCOUNT_URL = "https://api.avtomektep.kz/account";

const bot = new Telegraf(BOT_TOKEN);

// =====================
// 💾 MEMORY STORE
// =====================
const sessions = {};
const loginJobs = {};

// =====================
// 🎛 ГЛАВНОЕ МЕНЮ
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

// =====================
// 🔐 ПРОВЕРКА ВХОДА
// =====================
async function isLogged(page) {
    try {
        return await page.evaluate(() => !location.href.includes("auth/login"));
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

    const res = await fetch(ACCOUNT_URL, {
        headers: { Cookie: cookieHeader }
    });
    return await res.json();
}

async function getStudent(chatId) {
    const cookieHeader = await getCookieHeader(chatId);
    if (!cookieHeader) return null;

    const res = await fetch(API_URL, {
        headers: { Cookie: cookieHeader }
    });
    return await res.json();
}

// =====================
// 🔐 ЛОГИН — по кнопке
// =====================
async function handleLogin(ctx) {
    const chatId = ctx.chat.id;

    if (loginJobs[chatId]) {
        return ctx.reply("⏳ Вход уже запущен. Отсканируйте QR из предыдущего сообщения.");
    }

    await ctx.reply("🔐 Открываю страницу входа, подождите...");

    console.log('1. Запускаю браузер...');
    const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process'
        ]
    });
    const page = await browser.newPage();

    console.log('2. Браузер запущен, открываю страницу...');
    await page.goto(LOGIN_URL);
    console.log('3. Страница открыта, делаю скриншот...');

    const qrPath = `/tmp/qr_${chatId}.png`;
    await page.screenshot({ path: qrPath });

    console.log('4. Скриншот готов, отправляю...');
    await ctx.replyWithPhoto(
        { source: qrPath },
        { caption: "📱 Отсканируйте QR через приложение eGov\n\n⏳ Бот автоматически определит вход..." }
    );

    loginJobs[chatId] = setInterval(async () => {
        try {
            const logged = await isLogged(page);

            if (logged) {
                clearInterval(loginJobs[chatId]);
                delete loginJobs[chatId];

                const cookies = await page.context().cookies();
                sessions[chatId] = cookies;

                await browser.close();

                await ctx.reply("✅ Вы успешно вошли! Загружаю информацию...", mainMenu);
                await handleInfo(ctx);
            }
        } catch (e) {
            clearInterval(loginJobs[chatId]);
            delete loginJobs[chatId];
            await browser.close().catch(() => {});
            await ctx.reply("❌ Ошибка при входе. Попробуйте снова.", mainMenu);
        }
    }, 4000);
}

// =====================
// 📊 ИНФОРМАЦИЯ — по кнопке
// =====================
async function handleInfo(ctx) {
    const chatId = ctx.chat.id;

    const [data, accountData] = await Promise.all([
        getStudent(chatId),
        getAccount(chatId)
    ]);

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
    await ctx.reply(
        "👋 Добро пожаловать!\n\n📱 Этот бот показывает информацию об обучении в автошколе.\n\nВыберите действие:",
        mainMenu
    );
});

// =====================
// 🎛 ОБРАБОТЧИКИ КНОПОК
// =====================
bot.hears("🔐 Войти через QR", handleLogin);
bot.hears("📊 Информация об обучении", handleInfo);

// =====================
// ⌨️ КОМАНДЫ
// =====================
bot.command("login", handleLogin);
bot.command("info", handleInfo);

// =====================
bot.launch();
console.log("🚀 BOT RUNNING");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
