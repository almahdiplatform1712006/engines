// Arabic first, with an English switch that flips the page's direction.
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Language = "ar" | "en";

const ar = {
  appName: "إنجنز",
  switchLanguage: "English",
  signIn: "تسجيل الدخول",
  signUp: "إنشاء حساب",
  signOut: "تسجيل الخروج",
  name: "الاسم",
  email: "البريد الإلكتروني",
  password: "كلمة المرور",
  passwordHint: "10 أحرف على الأقل",
  withGoogle: "المتابعة باستخدام Google",
  haveAccount: "لديك حساب؟",
  noAccount: "ليس لديك حساب؟",
  or: "أو",
  organisations: "المؤسسات",
  newOrganisation: "مؤسسة جديدة",
  organisationName: "اسم المؤسسة",
  create: "إنشاء",
  noOrganisation: "أنشئ مؤسسة أو اقبل دعوة للبدء.",
  keys: "مفاتيح API",
  keyName: "اسم المفتاح",
  createKey: "إنشاء مفتاح",
  keyShownOnce: "انسخ هذا المفتاح الآن، فلن يظهر مرة أخرى.",
  copy: "نسخ",
  copied: "تم النسخ",
  done: "تم",
  revoke: "إلغاء",
  revoked: "ملغى",
  confirmRevoke: "إلغاء هذا المفتاح؟ ستتوقف أي منصة تستخدمه.",
  created: "أُنشئ",
  noKeys: "لا توجد مفاتيح بعد.",
  onlyAdmins: "المالكون والمسؤولون فقط يديرون المفاتيح.",
  members: "الأعضاء",
  invite: "دعوة",
  inviteEmail: "بريد العضو",
  role: "الدور",
  roles: { owner: "مالك", admin: "مسؤول", member: "عضو" },
  inviteLink: "أرسل هذا الرابط إلى العضو:",
  invitations: "الدعوات المعلّقة",
  acceptInvitation: "قبول الدعوة",
  invitationFor: "دعوة للانضمام إلى",
  usage: "الاستخدام والرصيد",
  balance: "الرصيد",
  pageCredits: "صفحة",
  ledger: "السجل",
  kinds: { grant: "منحة", hold: "حجز", release: "تحرير", usage: "استخدام" },
  kind: "النوع",
  listSeparator: "، ",
  document: "المستند",
  note: "ملاحظة",
  date: "التاريخ",
  pages: "الصفحات",
  nothingYet: "لا شيء بعد.",
  loading: "جارٍ التحميل…",
  error: "حدث خطأ",
  googleNotLinked:
    "هذا البريد مسجّل بكلمة مرور. سجّل الدخول بكلمة المرور أولاً.",
};

type Dictionary = typeof ar;

const en: Dictionary = {
  appName: "Engines",
  switchLanguage: "العربية",
  signIn: "Sign in",
  signUp: "Create account",
  signOut: "Sign out",
  name: "Name",
  email: "Email",
  password: "Password",
  passwordHint: "At least 10 characters",
  withGoogle: "Continue with Google",
  haveAccount: "Have an account?",
  noAccount: "No account yet?",
  or: "or",
  organisations: "Organisations",
  newOrganisation: "New organisation",
  organisationName: "Organisation name",
  create: "Create",
  noOrganisation: "Create an organisation or accept an invitation to start.",
  keys: "API keys",
  keyName: "Key name",
  createKey: "Create key",
  keyShownOnce: "Copy this key now. It won't be shown again.",
  copy: "Copy",
  copied: "Copied",
  done: "Done",
  revoke: "Revoke",
  revoked: "Revoked",
  confirmRevoke: "Revoke this key? Any platform using it stops working.",
  created: "Created",
  noKeys: "No keys yet.",
  onlyAdmins: "Only owners and admins manage keys.",
  members: "Members",
  invite: "Invite",
  inviteEmail: "Member's email",
  role: "Role",
  roles: { owner: "Owner", admin: "Admin", member: "Member" },
  inviteLink: "Send this link to the member:",
  invitations: "Pending invitations",
  acceptInvitation: "Accept invitation",
  invitationFor: "Invitation to join",
  usage: "Usage and balance",
  balance: "Balance",
  pageCredits: "pages",
  ledger: "Ledger",
  kinds: { grant: "Grant", hold: "Hold", release: "Release", usage: "Usage" },
  kind: "Kind",
  listSeparator: ", ",
  document: "Document",
  note: "Note",
  date: "Date",
  pages: "Pages",
  nothingYet: "Nothing yet.",
  loading: "Loading…",
  error: "Something went wrong",
  googleNotLinked:
    "This email signed up with a password. Sign in with your password first.",
};

const dictionaries: Record<Language, Dictionary> = { ar, en };

const STORAGE_KEY = "engines.language";

function storedLanguage(): Language {
  try {
    return localStorage.getItem(STORAGE_KEY) === "en" ? "en" : "ar";
  } catch {
    return "ar";
  }
}

interface I18n {
  t: Dictionary;
  language: Language;
  toggle: () => void;
  /** Numbers and dates written the way the language writes them. */
  number: (n: number) => string;
  date: (iso: string) => string;
}

const Context = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(storedLanguage);
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // Private windows: the choice lasts until the page closes.
    }
  }, [language]);
  const locale = language === "ar" ? "ar" : "en";
  const value: I18n = {
    t: dictionaries[language],
    language,
    toggle: () => {
      setLanguage((l) => (l === "ar" ? "en" : "ar"));
    },
    number: (n) => new Intl.NumberFormat(locale).format(n),
    date: (iso) =>
      new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
        new Date(iso),
      ),
  };
  return <Context value={value}>{children}</Context>;
}

export function useI18n(): I18n {
  const value = useContext(Context);
  if (!value) throw new Error("useI18n outside I18nProvider");
  return value;
}
