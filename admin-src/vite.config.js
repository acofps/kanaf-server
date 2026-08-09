import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/* البناء يكتب مباشرةً في admin-ui/ التي يخدمها Express من نفس
   الأصل (index.js). emptyOutDir يمسح الأصول القديمة ذات البصمة
   المختلفة، فلا تتراكم ملفات ميتة كما حصل في تطبيق المستخدم. */
export default defineConfig({
  plugins: [react()],
  build: { outDir: "../admin-ui", emptyOutDir: true },
});
