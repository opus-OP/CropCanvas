"use strict";

const STRINGS = {
  en: {
    appTitle: "Shorts template builder",
    loadVideo: "\u{1F4C1} Load video",
    videoNotLoaded: "no video loaded",
    render: "\u{1F3AC} Render",
    renderBusy: "Rendering\u2026",
    renderProgress: "Render: ",
    renderDone: "Done: ",
    renderError: "Render error: ",
    renderAlreadyRunning: "A render is already running",
    readVideoError: "Failed to read the video:\n",
    sourceTitle: "Source video \u2014 crop layout",
    outputTitle: "Output template preview",
    playPauseTitle: "Play / pause",
    openVideoTitle: "Choose the source video",
    outputDirTitle: "Where to save the finished clip",
    videoFilter: "Video",
    allFiles: "All files",
    langName: "EN",
    resLabel: "\u{1F4D2} Resolution",
    newTemplate: "\u2795 New",
    duplicateTemplate: "\u{1F504} Copy",
    deleteTemplate: "\u{1F5D1} Delete",
    modalTitle: "Template name",
    ok: "OK",
    cancel: "Cancel",
    deleteConfirm: "Delete template ",
  },
  ru: {
    appTitle: "\u0421\u0431\u043E\u0440\u043A\u0430 \u0448\u043E\u0440\u0442\u0441\u043E\u0432 \u043F\u043E \u0448\u0430\u0431\u043B\u043E\u043D\u0443",
    loadVideo: "\u{1F4C1} \u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0432\u0438\u0434\u0435\u043E",
    videoNotLoaded: "\u0432\u0438\u0434\u0435\u043E \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u043E",
    render: "\u{1F3AC} \u0420\u0435\u043D\u0434\u0435\u0440\u0438\u0442\u044C",
    renderBusy: "\u0420\u0435\u043D\u0434\u0435\u0440 \u0438\u0434\u0451\u0442\u2026",
    renderProgress: "\u0420\u0435\u043D\u0434\u0435\u0440: ",
    renderDone: "\u0413\u043E\u0442\u043E\u0432\u043E: ",
    renderError: "\u041E\u0448\u0438\u0431\u043A\u0430 \u0440\u0435\u043D\u0434\u0435\u0440\u0430: ",
    renderAlreadyRunning: "\u0420\u0435\u043D\u0434\u0435\u0440 \u0443\u0436\u0435 \u0438\u0434\u0451\u0442",
    readVideoError: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u044C \u0432\u0438\u0434\u0435\u043E:\n",
    sourceTitle: "\u0418\u0441\u0445\u043E\u0434\u043D\u043E\u0435 \u0432\u0438\u0434\u0435\u043E \u2014 \u0440\u0430\u0437\u043C\u0435\u0442\u043A\u0430 \u043A\u0440\u043E\u043F\u043E\u0432",
    outputTitle: "\u041F\u0440\u0435\u0432\u044C\u044E \u0448\u0430\u0431\u043B\u043E\u043D\u0430",
    playPauseTitle: "\u0412\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u0435\u0434\u0435\u043D\u0438\u0435 / \u043F\u0430\u0443\u0437\u0430",
    openVideoTitle: "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0438\u0441\u0445\u043E\u0434\u043D\u044B\u0439 \u0432\u0438\u0434\u0435\u043E\u0444\u0430\u0439\u043B",
    outputDirTitle: "\u041A\u0443\u0434\u0430 \u0441\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u0433\u043E\u0442\u043E\u0432\u044B\u0439 \u0440\u043E\u043B\u0438\u043A",
    videoFilter: "\u0412\u0438\u0434\u0435\u043E",
    allFiles: "\u0412\u0441\u0435 \u0444\u0430\u0439\u043B\u044B",
    langName: "RU",
    resLabel: "\u{1F4D2} \u0420\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u0438\u0435",
    newTemplate: "\u2795 \u041D\u043E\u0432\u044B\u0439",
    duplicateTemplate: "\u{1F504} \u041A\u043E\u043F\u0438\u044F",
    deleteTemplate: "\u{1F5D1} \u0423\u0434\u0430\u043B\u0438\u0442\u044C",
    modalTitle: "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u0448\u0430\u0431\u043B\u043E\u043D\u0430",
    ok: "OK",
    cancel: "\u041E\u0442\u043C\u0435\u043D\u0430",
    deleteConfirm: "\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0448\u0430\u0431\u043B\u043E\u043D ",
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
  const lt = document.getElementById("langToggle");
  if (lt) lt.textContent = "\uD83C\uDF10 " + s.langName;
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