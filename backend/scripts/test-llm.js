import "dotenv/config";
import { analyzeTranscript } from "../llm.js";

async function main() {
  console.log("[Test LLM] Testing LLM meeting analysis...");
  console.log(`[Test LLM] Provider: ${process.env.LLM_PROVIDER || "gemini"}, Model: ${process.env.LLM_MODEL || "gemini-2.5-flash"}`);

  if (!process.env.LLM_API_KEY || process.env.LLM_API_KEY === "your_gemini_or_openai_api_key_here") {
    console.warn("\n[Notice] LLM_API_KEY is not configured yet in backend/.env.");
    console.log("Please set your Gemini or OpenAI API key in backend/.env to run live LLM analysis.\n");
    return;
  }

  const sampleTranscript = `
আজকের মিটিংয়ে আমরা নতুন প্রজেক্টের ডেডলাইন এবং বাজেট নিয়ে আলোচনা করছি।
ক্লায়েন্ট চাচ্ছেন আগামী মাসের ১৫ তারিখের মধ্যে প্রথম বিটা ভার্সন রিলিজ করতে।
এদিকে ডিজাইন টিম জানিয়েছে তাদের কম্পোনেন্ট তৈরি করতে অন্তত দুই সপ্তাহ লাগবে।
আর বাজেট ৫ লাখ টাকার মধ্যে সীমাবদ্ধ রাখতে হবে, অতিরিক্ত খরচ কোনোভাবেই অনুমোদন করা হবে না।
তবে টেস্টিং ও কিউএ দায়িত্ব এখনো কাউকে আনুষ্ঠানিকভাবে দেওয়া হয়নি।
  `.trim();

  const topics = ["ডেডলাইন", "বাজেট", "টেস্টিং"];
  const questionKinds = ["স্পষ্টীকরণ", "গভীরে", "ঝুঁকি", "অ্যাকশন"];

  console.log("\n[Test LLM] Sample Transcript:\n", sampleTranscript);
  console.log("\n[Test LLM] Tracked Topics:", topics);
  console.log("\n[Test LLM] Calling LLM API...");

  const startTime = Date.now();
  const result = await analyzeTranscript({
    transcriptWindow: sampleTranscript,
    topics,
    existingQuestions: [],
    questionKinds,
  });
  const elapsed = Date.now() - startTime;

  console.log(`\n[Test LLM] Response received in ${elapsed}ms:\n`);
  console.log("Questions Generated (Hero format):");
  if (result.questions?.length) {
    result.questions.forEach((q, idx) => {
      console.log(`  ${idx + 1}. [${q.kind}] "${q.question}"`);
      console.log(`     Context quote: "${q.quote}"`);
    });
  } else {
    console.log("  (None generated)");
  }

  console.log("\nTopic Notes Generated:");
  if (result.notes?.length) {
    result.notes.forEach((n, idx) => {
      console.log(`  ${idx + 1}. ${n}`);
    });
  } else {
    console.log("  (None generated)");
  }

  console.log("\n[Test LLM] Test completed successfully!");
}

main().catch((err) => {
  console.error("[Test LLM Error]", err);
});
