import { test, expect } from "@playwright/test";
test("startup link signs in and removes the token from the address bar", async ({ page }) => {
  await page.goto("/#launch=browser-test-launch-token-123456");
  await expect(page.getByRole("heading", { name: "选择工作主机" })).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:4317/");
  const cookie = (await page.context().cookies()).find((item) => item.name === "acpao");
  expect(cookie?.httpOnly).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "选择工作主机" })).toBeVisible();
});
test("login → bootstrap → streamed workspace → delegation → approval → sessions → hosts → theme and mobile", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "让想法，开始流动。" })).toBeVisible();
  await page.getByLabel("工作区登录密钥").fill("browser-test-admin-secret-123456");
  await page.getByRole("button", { name: "进入工作区" }).click();
  await expect(page.getByRole("heading", { name: "选择工作主机" })).toBeVisible();
  await page.getByRole("button", { name: "配置 Agent" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "使用测试 Agent" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "开启工作区" }).click();
  await expect(page.getByRole("heading", { name: "一起，把工作向前推进。" })).toBeVisible();
  const input = page.getByRole("textbox", { name: "发送给 Agent 的指令" });
  await input.fill("检查本地完整链路");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.locator(".message.assistant")).toContainText("收到：检查本地完整链路");
  await expect(page.locator(".chat-meta .status")).toHaveText("已完成");
  await expect(page.locator(".markdown input[type=checkbox]").first()).toBeChecked();
  await input.fill("/permission 写入测试");
  await input.press("Enter");
  await expect(page.getByText("Agent 需要你的确认")).toBeVisible();
  await page.getByRole("button", { name: "仅允许这一次" }).click();
  await expect(page.getByText("Agent 需要你的确认")).not.toBeVisible();
  await expect(page.locator(".chat-meta .status")).toHaveText("已完成");
  await input.fill("/delegate 检查子会话");
  await input.press("Enter");
  await expect(page.locator(".delegation-strip a")).toContainText("检查子会话");
  await expect(page.locator(".message.assistant").last()).toContainText("测试委派结果", {
    timeout: 20000,
  });
  await expect(page.locator(".chat-meta .status")).toHaveText("已完成");
  await page.getByRole("link", { name: "会话", exact: true }).click();
  await expect(page.getByRole("heading", { name: "每一段工作，都有上下文。" })).toBeVisible();
  await page.getByRole("button", { name: "新建会话", exact: true }).first().click();
  await page.getByLabel("工作内容").fill("独立的第二项工作");
  await page.getByRole("button", { name: "创建会话" }).click();
  await expect(page.getByRole("heading", { name: "独立的第二项工作" })).toBeVisible();
  await page.getByRole("textbox", { name: "发送给 Agent 的指令" }).fill("/slow 可以取消");
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.getByRole("button", { name: "取消当前执行" }).click();
  await expect(page.locator(".chat-meta .status")).toHaveText("已取消");
  await page.getByRole("button", { name: "暗色主题", exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: "test-results/workspace-dark.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "亮色主题", exact: true }).click();
  await page.getByRole("link", { name: "主机", exact: true }).click();
  await expect(page.getByRole("heading", { name: "工作，在你的设备上发生。" })).toBeVisible();
  await page.getByRole("button", { name: "配对主机" }).click();
  await expect(page.getByLabel("SSH 主机")).toBeVisible();
  await expect(page.getByLabel("SSH 端口")).toBeVisible();
  await page.getByLabel("认证方式").selectOption("password");
  await expect(page.getByLabel("SSH 密码", { exact: true })).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "手动配对" }).click();
  await page.getByLabel("主机名称").fill("Linux 测试主机");
  await page.getByRole("button", { name: "生成一次性配对码" }).click();
  await expect(page.locator(".pair-result pre")).toContainText("ACPAO_PAIR_CODE");
  await expect(page.locator(".pair-result pre")).toContainText("acpao-gateway-linux-x64");
  await page.locator(".pair-result select").selectOption("windows-x64");
  await expect(page.locator(".pair-result pre")).toContainText("acpao-gateway-windows-x64.exe");
  await page.getByLabel("中心地址", { exact: true }).fill("https://acp.example.com/");
  await expect(page.locator(".pair-result pre")).toContainText("ACPAO_CENTER='https://acp.example.com'");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("link", { name: "工作区", exact: true }).click();
  await expect(page.locator(".message.assistant").last()).toContainText("测试委派结果");
  await page.screenshot({
    path: "test-results/workspace-light.png",
    fullPage: true,
  });
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByPlaceholder("搜索会话标题…").fill("独立的第二项工作");
  await page.getByPlaceholder("搜索会话标题…").press("Enter");
  await expect(page.getByRole("heading", { name: "独立的第二项工作" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "独立的第二项工作" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "发送给 Agent 的指令" })).toBeVisible();
  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.client);
  await page.screenshot({
    path: "test-results/workspace-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("diagnostics toggle, menu dismissal and Agent editor behave consistently", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("工作区登录密钥").fill("browser-test-admin-secret-123456");
  await page.getByRole("button", { name: "进入工作区" }).click();
  await page.getByRole("link", { name: "主机", exact: true }).click();
  await page.getByLabel("更多设置").click();
  await expect(page.locator(".more-menu")).toHaveAttribute("open", "");
  await page.getByRole("heading", { name: "工作，在你的设备上发生。" }).click();
  await expect(page.locator(".more-menu")).not.toHaveAttribute("open", "");
  await page.getByLabel("更多设置").click();
  await page.getByRole("button", { name: "日志与诊断" }).click();
  await expect(page.getByRole("heading", { name: "日志与诊断" })).toBeVisible();
  await expect(page.getByLabel("测试功能")).toBeChecked();
  await page.getByLabel("测试功能").uncheck();
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await page.getByRole("button", { name: "添加 Agent" }).click();
  await expect(page.getByRole("button", { name: "使用测试 Agent" })).toHaveCount(0);
  await page.mouse.click(2, 2);
  await expect(page.getByRole("heading", { name: "连接 ACP Agent" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "连接 ACP Agent" })).toHaveCount(0);
  await page.getByRole("button", { name: /编辑 测试 Agent/ }).click();
  await expect(page.getByRole("heading", { name: "编辑 ACP Agent" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "启动命令" })).toBeVisible();
});

test("Windows Agent command paste can be undone by bubble and Ctrl+Z", async ({ page }) => {
  await page.route("**/api/hosts", async (route) => {
    const response = await route.fetch();
    const hosts = await response.json() as { id: string; platform?: string }[];
    for (const host of hosts) if (host.id === "local") host.platform = "win32";
    await route.fulfill({ response, json: hosts });
  });
  await page.goto("/");
  await page.getByLabel("工作区登录密钥").fill("browser-test-admin-secret-123456");
  await page.getByRole("button", { name: "进入工作区" }).click();
  await page.getByRole("link", { name: "主机", exact: true }).click();
  await page.getByRole("button", { name: "添加 Agent" }).click();
  const editor = page.locator(".command-editor .cm-content");
  await editor.fill("");
  const paste = async () => page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "C:\\Program Files\\Code Agent\\agent.exe");
    document.querySelector(".command-editor .cm-content")!.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
    );
  });
  await paste();
  await expect(editor).toHaveText('"C:/Program Files/Code Agent/agent.exe"');
  await expect(page.getByRole("status").filter({ hasText: "已将 Windows 路径整理" })).toBeVisible();
  await page.getByRole("button", { name: "撤销 Windows 路径整理" }).click();
  await expect(editor).toBeEmpty();
  await paste();
  await editor.press("Control+z");
  await expect(editor).toBeEmpty();
});
