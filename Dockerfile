FROM node:18-alpine

# تحديد مجلد العمل
WORKDIR /app

# نسخ ملفات الاعتمادات وتثبيتها
COPY package*.json ./
RUN npm install --production

# نسخ بقية ملفات المشروع
COPY . .

# Hugging Face تفرض تشغيل السيرفر على منفذ 7860
EXPOSE 7860
ENV PORT=7860

# تشغيل السيرفر
CMD ["npm", "start"]
