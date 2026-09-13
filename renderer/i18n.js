"use strict";

const STRINGS = {
  en: {
    appTitle: "Shorts template builder",
    loadVideo: "\u{1F4C1} Load video",
    videoNotLoaded: "no video loaded",
    render: "\u{1F3AC} Render",
    renderBusy: "Rendering…",
    renderProgress: "Render: ",
    renderDone: "Done: ",
    renderError: "Render error: ",
    renderAlreadyRunning: "A render is already running",
    readVideoError: "Failed to read the video:\n",
    sourceTitle: "Source video — crop layout",
    outputTitle: "Output template preview (canvas grid 1080\u00D71920)",
    playPauseTitle: "Play / pause",
    openVideoTitle: "Choose the source video",
    outputDirTitle: "Where to save the finished clip",
    videoFilter: "Video",
    allFiles: "All files",
    langName: "EN",
  },
  ru: {
    appTitle: "Сборка шортсов по шаблону",
    loadVideo: "\u{1F4C1} Загрузить видео",
    videoNotLoaded: "видео не загружено",
    render: "\u{1F3AC} Рендерить",
    renderBusy: "Рендер идёт\u2026",
    renderProgress: "Рендер: ",
    renderDone: "Готово: ",
    renderError: "Ошибка рендера: ",
    renderAlreadyRunning: "Рендер уже идёт",
    readVideoError: "Не удалось прочитать видео:\n",
    sourceTitle: "Исходное видео — разметка кропов",
    outputTitle: "Превью итогового шаблона (сетка холста 1080\u00D71920)",
    playPauseTitle: "Воспроизведение / пауза",
    openVideoTitle: "Выберите исходный видеофайл",
    outputDirTitle: "Куда сохранить готовый ролик",
    videoFilter: "Видео",
    allFiles: "Все файлы",
    langName: "RU",
  },
};

let lang = "en";

function detectLang() {
  return (navigator.language || "en").toLowerCase().includes("ru") ? "ru" : "en";
}

function loadSavedLang() {
  const saved = localStorage.getItem("lang");
  if (saved === "ru" || saved === "en") return saved;
  return detectLang();
}

function apply() {
  const s = STRINGS[lang];
  document.documentElement.lang = lang;
  document.getElementById("langToggle").textContent = "🌐 " + s.langName;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (s[key] !== undefined) el.textContent = s[key];
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const key = el.dataset.i18nTitle;
    if (s[key] !== undefined) el.setAttribute("title", s[key]);
  });
}

function initI18n() {
  lang = loadSavedLang();
  apply();
  document.getElementById("langToggle").addEventListener("click", () => {
    lang = lang === "ru" ? "en" : "ru";
    localStorage.setItem("lang", lang);
    apply();
    window.api.setLocale(lang);
    document.dispatchEvent(new CustomEvent("langchange", { detail: lang }));
  });
  window.api.setLocale(lang);
}

function i18n(key) {
  return STRINGS[lang][key] !== undefined ? STRINGS[lang][key] : key;
}

function getLang() {
  return lang;
}

function locName(t) {
  return lang === "ru" ? t.name : (t.nameEn || t.name);
}

function locLabel(z) {
  return lang === "ru" ? z.label : (z.labelEn || z.label);
}

window.I18n = { initI18n, i18n, getLang, locName, locLabel };