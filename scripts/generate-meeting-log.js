// GitHub 이슈 중 "Scrum" 라벨이 붙은 것들을 모아서 회의록.md(위키 페이지)를 생성하는 스크립트.
import fs from "fs";
import path from "path";

const GITHUB_ISSUE_TOKEN = process.env.WIKI_SYNC_PAT || process.env.GITHUB_ISSUE_TOKEN;
const ISSUE_REPO = process.env.ISSUE_REPO || process.env.GITHUB_REPOSITORY || "";
const OUTPUT_DIR = process.env.OUTPUT_DIR || "wiki-sync-output";

if (!GITHUB_ISSUE_TOKEN || !ISSUE_REPO) {
    console.error("GITHUB_ISSUE_TOKEN, ISSUE_REPO(또는 GITHUB_REPOSITORY) 환경변수가 필요합니다.");
    process.exit(1);
}

const GROUPS = [
    { label: "DailyScrum", title: "Daily Scrum", icon: "🟢" },
    { label: "TeamMeeting", title: "Team Meeting", icon: "🟣" },
    { label: "WeeklyMeeting", title: "Weekly Scrum", icon: "🔵" },
    { label: "EmergencyMeeting", title: "Emergency Meeting", icon: "🔴" },
];

async function fetchWithRetry(url, options, maxRetries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const res = await fetch(url, options);
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`HTTP ${res.status}: ${text}`);
            }
            return res;
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
                const delayMs = 5000 * attempt;
                console.warn(`⚠️  시도 ${attempt}/${maxRetries} 실패: ${error.message}`);
                console.warn(`   ${delayMs}ms 후 재시도...`);
                await new Promise((r) => setTimeout(r, delayMs));
            }
        }
    }
    throw new Error(`이슈 조회 실패 (${maxRetries}회 재시도 후): ${lastError.message}`);
}

async function fetchScrumIssues() {
    const issues = [];
    let page = 1;
    let totalPages = null;

    while (!totalPages || page <= totalPages) {
        console.log(`  - Scrum 이슈 조회 중 (페이지 ${page})...`);
        const res = await fetchWithRetry(
            `https://api.github.com/repos/${ISSUE_REPO}/issues?labels=Scrum&state=all&per_page=100&page=${page}`,
            {
                headers: {
                    Authorization: `Bearer ${GITHUB_ISSUE_TOKEN}`,
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            }
        );

        const batch = await res.json();
        issues.push(...batch.filter((i) => !i.pull_request));
        if (batch.length < 100) {
            totalPages = page;
        } else {
            page += 1;
        }
    }
    return issues;
}

function extractMeta(body) {
    const dateMatch = body?.match(/\*\*날짜\*\*:\s*(.+)/);
    const masterMatch = body?.match(/\*\*스크럼마스터\*\*:\s*(.+)/);
    return {
        date: dateMatch ? dateMatch[1].trim() : "",
        scrumMaster: masterMatch ? masterMatch[1].trim() : "",
    };
}

function buildTable(issues) {
    if (issues.length === 0) {
        return "_등록된 항목이 없습니다._\n";
    }
    const sorted = [...issues].sort((a, b) =>
        (b._meta.date || "").localeCompare(a._meta.date || "")
    );
    const lines = [
        "| 날짜 | 제목 | 스크럼마스터 | 상태 |",
        "|---|---|---|---|",
    ];
    for (const issue of sorted) {
        const status = issue.state === "open" ? "🟢 Open" : "🔴 Closed";
        const dateLabel = issue._meta.date || "-";
        const masterLabel = issue._meta.scrumMaster || "-";
        lines.push(
            `| ${dateLabel} | [${issue.title}](${issue.html_url}) | ${masterLabel} | ${status} |`
        );
    }
    return lines.join("\n") + "\n";
}

async function main() {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`🔍 GitHub 이슈 조회 시작 (레포: ${ISSUE_REPO})...`);
    const issues = await fetchScrumIssues();
    console.log(`✅ Scrum 라벨 이슈 ${issues.length}건 조회 완료.`);

    for (const issue of issues) {
        issue._meta = extractMeta(issue.body || "");
    }

    const now = new Date().toISOString();
    const parts = [
        "# 📓 회의록",
        "",
        "> 이 페이지는 GitHub Actions가 자동 생성합니다.",
        `> 마지막 생성: ${now}`,
        "",
    ];

    for (const group of GROUPS) {
        const groupIssues = issues.filter((i) =>
            i.labels.some((l) => (l.name || l) === group.label)
        );
        parts.push(`## ${group.icon} ${group.title}`, "", buildTable(groupIssues), "");
    }

    const filePath = path.join(OUTPUT_DIR, "회의록.md");
    fs.writeFileSync(filePath, parts.join("\n"));
    console.log(`✅ 회의록.md 생성 완료 (${filePath})`);
}

main().catch((err) => {
    console.error("❌ 회의록 생성 중 오류 발생:", err.message);
    process.exit(1);
});