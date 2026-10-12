# وضعیت تحویل

## به‌روزرسانی ۱٫۱ — تاریخچه و اصلاح کارت

در ۲۰۲۶-۱۰-۱۲، تاریخچهٔ مستقل هر کارت و اصلاح اسم/قیمت با حفظ دور، صاحب و وضعیت اضافه شد. پرداخت تسویهٔ قبلی ثابت می‌ماند؛ Undo اصلاح و رویداد آن را یکجا برمی‌گرداند. دادهٔ دفترهای قبلی، Undo، بایگانی و JSON با ارتقای اتمیک حفظ می‌شوند؛ گذشتهٔ ثبت‌نشده فقط baseline با زمان نامشخص دارد.

بررسی محلی: ۵۳ تست منطق/ذخیره و ۳۲ تست Chromium موفق. انتشار از شاخهٔ ویژگی ابتدا Preview می‌سازد؛ پس از بررسی همان source، fast-forward روی `master` انتشار خودکار Production را انجام می‌دهد. نتیجهٔ نهایی انتشار و شناسهٔ نسخه در گزارش این درخواست ثبت می‌شود. آدرس اصلی همان https://mortgage-monopoly.vercel.app/ است؛ نام پایگاه داده و Schema عوض نشده‌اند.

## تحویل اولیهٔ ۱٫۰

تکمیل و راستی‌آزمایی در ۲۰۲۶-۱۰-۱۲.

- برنامهٔ عمومی: https://mortgage-monopoly.vercel.app/ — پاسخ ۲۰۰ در مرورگر تمیز، بدون ورود و بدون header احراز هویت.
- منبع برنامه: commit `04579b39e0c4e4c9b968306570356cd8956350dd` روی `master` در `Raminyazdani/mortgage_monopoly`؛ نسخهٔ نمایش‌داده‌شده `04579b3`. commit بعدی فقط مستندات تحویل را به‌روز می‌کند و source منتشرشده را تغییر نمی‌دهد.
- Vercel Production: `dpl_4rMS7KtbhtQ9x4VgmqFszpoHuWkV`، وضعیت READY؛ SHA منبع در metadata با Git و نسخهٔ داخل صفحه مطابق است. Preview نهایی: `dpl_Fk5tTr8EJU4QjVrXHxwstX2Lf9mC`، وضعیت READY؛ دو جریان اصلی و محافظ خروج هنگام ذخیره با دسترسی مجاز حساب آزموده شدند.
- پروژهٔ اختصاصی `mortgage-monopoly`، تیم `ramin-yazdanis-projects`، شناسهٔ `prj_6jlsvfYfjBSyFp3eXVWFVFDRRoX9`؛ root همین repo، Node 24.x، build برابر `npm run build` و خروجی `dist`.
- منطق و ذخیره: ۳۲/۳۲ آزمون موفق. مرورگر روی build محلی: ۲۵ سناریوی اولیه و regression خروج هنگام ذخیره موفق. نسخهٔ نهایی روی Production عمومی: **۲۶/۲۶ Chromium موفق**، شامل انتقال، تسویه، grace، مزایده، Undo، مهاجرت، خطای نوشتن، دادهٔ خراب، تداخل دو تب، export/import و بایگانی.
- موبایل شبیه‌سازی‌شدهٔ ۳۶۰، ۳۹۰ و ۴۳۰ پیکسل بدون overflow یا console error. WebKit روی Production نهایی، جریان کامل ۳۹۰ پیکسل موفق. گوشی فیزیکی و نصب واقعی روی گوشی آزموده نشده‌اند.
- کار صفحهٔ باز بدون شبکه، قطع شبکه و reload واقعی پس از آماده‌شدن worker، و فعال‌کردن worker تازه با حفظ دفتر و ورودی آزموده شدند. دادهٔ دفتر خارج از cache برنامه است.
- دادهٔ واقعی آرتیفکت قدیمی در فایل HTML وجود نداشت؛ انتقال دادهٔ واقعی کاربر ادعا نشده است. مهاجرت fixture و import قدیمی آزموده‌اند؛ راهنمای استخراج از همان origin قدیمی در README است.

## ادامهٔ توسعه و انتشار

Checkout: `E:/mortgage_system`. مقصد تنها `https://github.com/Raminyazdani/mortgage_monopoly.git` و شاخهٔ تولید `master` است. اتصال رسمی Git برای pushهای بعدی باید همین repo و branch را نشان دهد؛ فرمان آن `vercel git connect https://github.com/Raminyazdani/mortgage_monopoly.git --yes --scope ramin-yazdanis-projects` است. اتصال در انتشار اولیه موقتاً قطع شد تا push و انتشار دستی دو build ناخواسته ایجاد نکنند.

برای بررسی مقصد پیش از انتشار: `vercel project inspect --non-interactive --scope ramin-yazdanis-projects` و metadata پروژه/شاخه را کنترل کنید. تست‌ها: `npm test`، `npm run build`، `npm run test:browser`. در PowerShell برای Production: `$env:PLAYWRIGHT_BASE_URL='https://mortgage-monopoly.vercel.app'; npx playwright test`؛ از context مصنوعی و مستقل استفاده کنید.

در نخستین درخواست ابزار MCP، با وجود target=preview، deployment واقعاً production ساخته شد؛ این تفاوت از API/CLI تأیید و گزارش شد. برای Preview از CLI با `--target preview` استفاده شد. در انتشار نهایی، Preview همان commit ابتدا آزموده شد و سپس Production ساخته و تمام جریان‌ها روی دامنهٔ پایدار آزموده شدند.

محدودیت باقی‌مانده فقط آزمون دستگاه فیزیکی است. secret، node_modules، پروفایل مرورگر، دادهٔ بازی واقعی و خروجی موقت تست در Git قرار ندارند. برای تغییر آدرس، از JSON خروجی/بازیابی استفاده کنید؛ originهای مختلف دفتر مشترک ندارند.
