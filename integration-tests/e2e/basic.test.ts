import { execSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type Page,
	expect,
	test,
	type APIRequestContext,
} from "@playwright/test";

const basePath = process.env.BASEPATH || "";
const baseURL =
	process.env.E2E_BASE_URL ||
	`http://localhost:${Number(process.env.E2E_PORT || 6174)}`;
const isStart = Boolean(process.env.E2E_START) || Boolean(process.env.E2E_BASE_URL);
const isRemote = Boolean(process.env.E2E_BASE_URL);

// Prepend base path to a route path for page.goto and fetch calls.
// Allows tests to work identically with and without BASEPATH.
function url(path: string): string {
	return basePath + path;
}

function getSetCookies(response: Response) {
	const getSetCookie = Reflect.get(response.headers, "getSetCookie");
	if (typeof getSetCookie !== "function") return [];
	return getSetCookie.call(response.headers);
}

function normalizePath(value: string): string {
	return value.replaceAll("\\", "/");
}

function getAddressInfo(server: ReturnType<typeof createServer>): AddressInfo {
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Expected test server to expose an AddressInfo");
	}
	return address;
}

function copyStandaloneDist() {
	const tempDir = mkdtempSync(join(tmpdir(), "spiceflow-takumi-standalone-"));
	cpSync("dist", join(tempDir, "dist"), { recursive: true });
	return tempDir;
}

function findPackageRoot(modulePath: string): string {
	let currentDir = dirname(modulePath);
	while (true) {
		const packageJsonPath = join(currentDir, "package.json");
		if (existsSync(packageJsonPath)) return currentDir;

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			throw new Error(`Could not find package.json for module path: ${modulePath}`);
		}
		currentDir = parentDir;
	}
}

function resolveTakumiRuntimeFromStandalone({ tempDir }: { tempDir: string }) {
	const standaloneRequire = createRequire(join(tempDir, "dist/rsc/index.js"));
	const coreEntryPath = normalizePath(realpathSync(standaloneRequire.resolve("@takumi-rs/core")));
	const corePackageJsonPath = normalizePath(
		join(findPackageRoot(coreEntryPath), "package.json"),
	);
	const corePackageJson = JSON.parse(readFileSync(corePackageJsonPath, "utf-8")) as {
		optionalDependencies?: Record<string, string>;
	};

	for (const dependency of Object.keys(corePackageJson.optionalDependencies ?? {})) {
		try {
			const nativeEntryPath = normalizePath(
				realpathSync(standaloneRequire.resolve(dependency)),
			);
			const nativePackageJsonPath = normalizePath(
				join(findPackageRoot(nativeEntryPath), "package.json"),
			);
			return {
				corePackageJsonPath,
				nativeBinaryPath: nativeEntryPath,
				nativePackageJsonPath,
			};
		} catch {
			// Only the active platform package should resolve in the standalone output.
		}
	}

	throw new Error("No standalone Takumi native runtime package was found");
}

async function getFreePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer();
		server.listen(0, () => {
			const port = getAddressInfo(server).port;
			server.close(() => resolve(port));
		});
	});
}

async function waitForServer({
	child,
	port,
}: {
	child: ChildProcessWithoutNullStreams;
	port: number;
}) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 10_000) {
		if (child.exitCode !== null) {
			throw new Error(`Standalone server exited early with code ${child.exitCode}`);
		}

		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/hello`);
			if (response.ok) return;
		} catch {
			// Server is still starting.
		}

		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	throw new Error(`Timed out waiting for standalone server on port ${port}`);
}

async function stopProcess({ child }: { child: ChildProcessWithoutNullStreams }) {
	if (child.exitCode !== null) return;

	child.kill("SIGTERM");
	await Promise.race([
		new Promise<void>((resolve) => child.once("exit", () => resolve())),
		new Promise<void>((resolve) =>
			setTimeout(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
				resolve();
			}, 1_000),
		),
	]);
}

// Warm up the dev server so the Vite dep optimizer settles before real tests run.
// The first request can trigger a "program reload" that races with assertions.
test.beforeAll(async () => {
	if (isStart) return;
	for (let i = 0; i < 5; i++) {
		try {
			const res = await fetch(baseURL + url("/"));
			await res.text();
			// After a successful response, do one more request to absorb any
			// in-flight dep optimization reload.
			await new Promise((r) => setTimeout(r, 500));
			const res2 = await fetch(baseURL + url("/"));
			await res2.text();
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 500));
		}
	}
});

test.describe("not found", () => {
	test("not found in outer route scope", async ({ page }) => {
		await page.goto(url("/not-found"));
		await expect(page.getByText("404")).toBeVisible();
		await expect(page.getByText("This page could not be found.")).toBeVisible();
	});

	test("not found in RSC inside suspense", async ({ page }) => {
		await page.goto(url("/not-found-in-suspense"));
		await expect(page.getByText("404")).toBeVisible();
		await expect(page.getByText("This page could not be found.")).toBeVisible();
	});

	test("unmatched route renders layout-based 404 for browser requests", async ({
		page,
	}) => {
		const response = await page.goto(url("/a/b/does-not-exist"));
		expect(response?.status()).toBe(404);
		// The layout detects children=null and renders custom 404 inside the layout shell
		await expect(page.getByTestId("layout-not-found")).toBeVisible();
		await expect(page.getByText("404")).toBeVisible();
		await expect(page.getByText("This page could not be found.")).toBeVisible();
	});

	test("unmatched route under nested /app/* layout renders root layout 404", async ({
		page,
	}) => {
		const response = await page.goto(url("/app/does-not-exist"));
		expect(response?.status()).toBe(404);
		await expect(page.getByTestId("layout-not-found")).toBeVisible();
		await expect(page.getByText("404")).toBeVisible();
	});

	test("unmatched route under nested /docs/* layout renders root layout 404", async ({
		page,
	}) => {
		const response = await page.goto(url("/docs/does-not-exist"));
		expect(response?.status()).toBe(404);
		await expect(page.getByTestId("layout-not-found")).toBeVisible();
		await expect(page.getByText("404")).toBeVisible();
	});

	test("unmatched route returns plain text for non-browser requests", async () => {
		const response = await fetch(`${baseURL}${basePath}/a/b/does-not-exist`);
		expect(response.status).toBe(404);
		const text = await response.text();
		expect(text).toBe("Not Found");
	});

	test("bare / redirects to base path when base is set", async () => {
		test.skip(!basePath, "only relevant when BASEPATH is set");
		const response = await fetch(`${baseURL}/`, { redirect: "manual" });
		expect(response.status).toBe(302);
		const location = response.headers.get("location") || "";
		expect(location.startsWith(basePath)).toBe(true);
	});
});
test.describe("API route priority over layout-only matches", () => {
	// layout("/*") matches /api/hello but there's no page for it — the .get()
	// handler should execute instead of entering the React rendering path.
	test("GET /api/hello returns API response, not React 404", async () => {
		const response = await fetch(`${baseURL}${basePath}/api/hello`);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain("Hello from API!");
	});

	test("POST /api/echo returns API response when layout matches", async () => {
		const response = await fetch(`${baseURL}${basePath}/api/echo`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ test: true }),
		});
		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.echo).toEqual({ test: true });
	});

	test("GET /api/hello via browser returns API response, not React 404", async ({
		page,
	}) => {
		const response = await page.goto(url("/api/hello"));
		expect(response?.status()).toBe(200);
		const text = await page.textContent("body");
		expect(text).toContain("Hello from API!");
	});

	test("GET /api/setup via browser returns GET handler, not layout 404", async ({
		page,
	}) => {
		const response = await page.goto(url("/api/setup"));
		expect(response?.status()).toBe(200);
		const text = await page.textContent("body");
		expect(text).toContain("setup");
		await expect(page.getByTestId("layout-not-found")).toHaveCount(0);
	});
});

test.describe("staticGet runtime", () => {
	test("staticGet route responds with JSON at runtime", async () => {
		const response = await fetch(
			`${baseURL}${basePath}/api/staticfile.json`,
		);
		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.name).toBe("integration-tests");
		expect(json.features).toContain("static-get");
	});
});

test.describe("middleware with use()", () => {
	test("middleware sets response header", async ({ page }) => {
		const response = await page.goto(url("/"));
		expect(response?.headers()["x-middleware-1"]).toBe("ok");
	});
	test("middleware sets state", async ({ page }) => {
		await page.goto(url("/state"));
		await expect(page.getByText("state set by middleware1")).toBeVisible();
	});
	test("middleware receives SSR HTML response for browser requests", async () => {
		const response = await fetch(`${baseURL}${basePath}/`, {
			headers: { "sec-fetch-dest": "document" },
		});
		expect(response.headers.get("x-middleware-response-type")).toBe(
			"text/html;charset=utf-8",
		);
	});
	test("middleware receives RSC flight response for RSC requests", async () => {
		const response = await fetch(`${baseURL}${basePath}/?__rsc=1`, {
			headers: { accept: "text/x-component" },
		});
		expect(response.headers.get("x-middleware-response-type")).toBe(
			"text/x-component;charset=utf-8",
		);
	});
	test("api routes can set response headers through context.response", async () => {
		const response = await fetch(`${baseURL}${basePath}/api/response-headers`);
		expect(response.status).toBe(200);
		expect(response.headers.get("x-api-header")).toBe("ok");
		expect(getSetCookies(response).join("\n")).toContain("api-cookie=1");
		expect(await response.json()).toEqual({ ok: true });
	});
});

test.describe("response headers from page and layout handlers", () => {
	test("document response includes page and layout headers", async () => {
		const response = await fetch(`${baseURL}${basePath}/response-headers`, {
			headers: { "sec-fetch-dest": "document" },
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, max-age=60");
		expect(response.headers.get("x-page-header")).toBe("page");
		expect(response.headers.get("x-layout-header")).toBe("layout");
		expect(getSetCookies(response).join("\n")).toContain("page-cookie=1");
	});

	test("rsc response includes page and layout headers", async () => {
		const response = await fetch(`${baseURL}${basePath}/response-headers?__rsc=1`, {
			headers: { accept: "text/x-component" },
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, max-age=60");
		expect(response.headers.get("x-page-header")).toBe("page");
		expect(response.headers.get("x-layout-header")).toBe("layout");
		expect(getSetCookies(response).join("\n")).toContain("page-cookie=1");
	});

	test("redirect response keeps cookies from route headers", async () => {
		const response = await fetch(`${baseURL}${basePath}/response-headers/redirect`, {
			redirect: "manual",
			headers: { "sec-fetch-dest": "document" },
		});

		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(url("/response-target"));
		expect(response.headers.get("x-layout-header")).toBe("layout");
		expect(getSetCookies(response).join("\n")).toContain("before-redirect=1");
	});

	test("client-side navigation applies cookies from the rsc response", async ({
		page,
	}) => {
		await page.goto(url("/response-nav"));
		await page.getByTestId("response-nav-link").click();
		await expect(page).toHaveURL(url("/response-headers"), { timeout: 10000 });
		await expect(page.getByTestId("response-headers-page")).toBeVisible({
			timeout: 10000,
		});

		const cookies = await page.context().cookies();
		expect(cookies.some((cookie) => cookie.name === "page-cookie")).toBe(true);
	});
});

test.describe("layout provided client context", () => {
	test("client context value is present in the SSR html", async () => {
		const response = await fetch(`${baseURL}${basePath}/layout-client-context`, {
			headers: { "sec-fetch-dest": "document" },
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toContain("from-layout-client-provider");
	});

	test("client context value is available after client navigation", async ({
		page,
	}) => {
		await page.goto(url("/layout-client-context-nav"));
		await page.getByTestId("layout-client-context-nav-link").click();
		await expect(page.getByTestId("layout-client-context-value")).toHaveText(
			"from-layout-client-provider",
		);
	});
});

test.describe("scoped wildcard layouts", () => {
	test("/app/* and /docs/* also match their base paths", async ({ page }) => {
		await page.goto(url("/app"));
		await expect(page.getByTestId("app-layout")).toBeVisible();
		await expect(page.getByTestId("app-page")).toBeVisible();

		await page.goto(url("/docs"));
		await expect(page.getByTestId("docs-layout")).toBeVisible();
		await expect(page.getByTestId("docs-page")).toBeVisible();
	});

	test("nested scoped layouts reuse the root document shell", async () => {
		const response = await fetch(`${baseURL}${basePath}/app`, {
			headers: { "sec-fetch-dest": "document" },
		});

		expect(response.status).toBe(200);
		const html = await response.text();

		expect(html).toContain('data-testid="app-layout"');
		expect(html).toContain('data-testid="app-page"');
		expect(html.match(/<html(?:\s|>)/g)).toHaveLength(1);
		expect(html.match(/<body(?:\s|>)/g)).toHaveLength(1);
	});

	test("duplicate layouts on the same path both render in registration order", async ({
		page,
	}) => {
		await page.goto(url("/duplicate-layout"));
		await expect(page.getByTestId("duplicate-layout-a")).toBeVisible();
		await expect(page.getByTestId("duplicate-layout-b")).toBeVisible();
		await expect(page.getByTestId("duplicate-layout-page")).toBeVisible();
		await expect(
			page.locator(
				'[data-testid="duplicate-layout-a"] [data-testid="duplicate-layout-b"] [data-testid="duplicate-layout-page"]',
			),
		).toBeVisible();
	});

	test("scoped wildcard layouts still wrap nested child routes", async ({ page }) => {
		await page.goto(url("/app/settings"));
		await expect(page.getByTestId("app-layout")).toBeVisible();
		await expect(page.getByTestId("app-settings-page")).toBeVisible();

		await page.goto(url("/docs/getting-started"));
		await expect(page.getByTestId("docs-layout")).toBeVisible();
		await expect(page.getByTestId("docs-getting-started-page")).toBeVisible();
	});
});

test.describe("Head client components", () => {
	test("document response includes Head.Title and deduplicated meta tags", async () => {
		const response = await fetch(`${baseURL}${basePath}/meta`, {
			headers: { "sec-fetch-dest": "document" },
		});

		expect(response.status).toBe(200);
		const html = await response.text();

		expect(html).toContain("<title>Spiceflow Example</title>");
		expect(html).toContain('<meta name="test" content="value"/>');
		expect(html.match(/<meta name="test" content="value"\/>/g)).toHaveLength(1);
		expect(html).toContain(
			`<meta property="og:image" content="${baseURL}/og-image.jpg"/>`,
		);
	});

	test("browser document title and meta tags are available after hydration", async ({
		page,
	}) => {
		await page.goto(url("/meta"));

		await expect(page).toHaveTitle("Spiceflow Example");
		await expect(page.locator('head meta[name="test"]')).toHaveCount(1);
		await expect(
			page.locator('head meta[property="og:title"]'),
		).toHaveAttribute("content", "Spiceflow Example");
		await expect(
			page.locator('head meta[property="og:image"]'),
		).toHaveAttribute("content", `${baseURL}/og-image.jpg`);
	});

	test("page Head overrides layout title and meta tags by key", async () => {
		const response = await fetch(`${baseURL}${basePath}/meta-override`, {
			headers: { "sec-fetch-dest": "document" },
		});

		expect(response.status).toBe(200);
		const html = await response.text();

		expect(html.match(/<title>/g)).toHaveLength(1);
		expect(html).toContain("<title>Page title</title>");
		expect(html).not.toContain("<title>Layout title</title>");
		expect(html.match(/<meta name="description"/g)).toHaveLength(1);
		expect(html).toContain(
			'<meta name="description" content="Page description"/>',
		);
		expect(html).not.toContain(
			'<meta name="description" content="Layout description"/>',
		);
		expect(html.match(/<meta property="og:title"/g)).toHaveLength(1);
		expect(html).toContain(
			'<meta property="og:title" content="Page og:title"/>',
		);
		expect(html).not.toContain(
			'<meta property="og:title" content="Layout og:title"/>',
		);
	});

	test("browser head keeps only page overrides after hydration", async ({
		page,
	}) => {
		await page.goto(url("/meta-override"));

		await expect(page).toHaveTitle("Page title");
		await expect(page.locator("head title")).toHaveCount(1);
		await expect(page.locator('head meta[name="description"]')).toHaveCount(1);
		await expect(page.locator('head meta[name="description"]')).toHaveAttribute(
			"content",
			"Page description",
		);
		await expect(page.locator('head meta[property="og:title"]')).toHaveCount(1);
		await expect(
			page.locator('head meta[property="og:title"]'),
		).toHaveAttribute("content", "Page og:title");
	});

	test("page title is not overridden by layout title after hydration", async ({
		page,
	}) => {
		await page.goto(url("/meta-override"));
		// Wait for hydration to complete so DocumentTitle's useEffect has fired.
		// layout-mount-count goes from 0 to 1 after the layout client component mounts.
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1");
		// document.title must still be the page's title, not the layout's.
		// DocumentTitle runs client-side via useEffect and must receive the same
		// deduped title value that CollectedHead rendered server-side.
		expect(await page.title()).toBe("Page title");
	});

	test("document.title updates on client-side navigation", async ({ page }) => {
		await page.goto(url("/title-nav-a"));
		await expect(page).toHaveTitle("Title A");

		await page.getByTestId("title-nav-link").click();
		await expect(page).toHaveURL(url("/title-nav-b"));
		await expect(page).toHaveTitle("Title B");

		await page.getByTestId("title-nav-link").click();
		await expect(page).toHaveURL(url("/title-nav-a"));
		await expect(page).toHaveTitle("Title A");
	});
});

test.describe("redirect", () => {
	test("redirect in outer route scope", async ({ page }) => {
		await page.goto(url("/top-level-redirect"));
		await expect(page).toHaveURL(url("/"));
		await page.getByText("[hydrated: 1]").click();
	});
	test("redirect in RSC", async ({ page }) => {
		await page.goto(url("/redirect-in-rsc"));
		await expect(page).toHaveURL(url("/"));
		await page.getByText("[hydrated: 1]").click();
	});
	test("redirect in RSC, slow (meaning not first rsc chunk)", async ({
		page,
	}) => {
		await page.goto(url("/slow-redirect"));
		await expect(page).toHaveURL(url("/"));
		await page.getByText("[hydrated: 1]").click();
	});
	test("redirect in RSC inside suspense, redirect made by client", async ({
		page,
	}) => {
		await page.goto(url("/redirect-in-rsc-suspense"));
		await expect(page).toHaveURL(url("/"));
		await page.getByText("[hydrated: 1]").click();
	});
});

test("client reference", async ({ page }) => {
	await page.goto(url("/"));
	await page.getByText("[hydrated: 1]").click();
	const clientCounter = page
		.getByTestId("client-counter")
		.filter({ hasText: "Client counter" });
	await clientCounter.getByText("Client counter: 0").click();
	await clientCounter.getByRole("button", { name: "+" }).click();
	await clientCounter.getByText("Client counter: 1").click();
	await page.reload();
	await clientCounter.getByText("Client counter: 0").click();
});

test("document SSR preinitializes client chunks for client references", async ({
	request,
}) => {
	const response = await request.get("/");
	expect(response.status()).toBe(200);
	const html = await response.text();

	expect(html).toContain('data-testid="client-counter"');
	expect(html).toContain('data-precedence="vite-rsc/client-reference"');
});

test("server reference in server @js", async ({ page }) => {
	await testServerAction(page);
});

test.describe(() => {
	test.use({ javaScriptEnabled: false });
	test("server reference in server @nojs", async ({ page }) => {
		await testServerAction(page);
	});

	test("progressive enhancement POST preserves client reference hints", async ({
		page,
	}) => {
		await page.goto(url("/"));
		await page
			.getByTestId("server-counter")
			.getByRole("button", { name: "+" })
			.click();

		const html = await page.content();
		expect(html).toContain('data-testid="client-counter"');
		expect(html).toContain('data-precedence="vite-rsc/client-reference"');
	});

	test("no-JS form action redirect returns 303 and navigates @nojs", async ({
		page,
	}) => {
		// With JS disabled, the browser submits the form as a regular POST.
		// The server should respond with 303 (not 307) so the browser follows
		// with a GET instead of re-POSTing to the redirect target.
		const response = await page.goto(url("/form-redirect-nojs"));
		expect(response?.status()).toBe(200);
		await page.getByRole("button", { name: "Submit" }).click();
		await expect(page).toHaveURL(url("/other"), { timeout: 10000 });
	});
});

async function testServerAction(page: Page) {
	await page.goto(url("/"));
	// Read the current counter value (may not be 0 on serverless with persistent storage)
	const counterText = await page
		.getByTestId("server-counter")
		.locator("div")
		.filter({ hasText: /^Server counter:/ })
		.textContent();
	const initial = Number(counterText!.replace("Server counter: ", ""));
	await page
		.getByTestId("server-counter")
		.getByRole("button", { name: "+" })
		.click();
	await page.getByText(`Server counter: ${initial + 1}`).click();
	await page.goto(url("/"));
	await page.getByText(`Server counter: ${initial + 1}`).click();
	await page
		.getByTestId("server-counter")
		.getByRole("button", { name: "-" })
		.click();
	await page.getByText(`Server counter: ${initial}`).click();
}

test("server reference in client @js", async ({ page }) => {
	await testServerAction2(page, { js: true });
});

test.describe(() => {
	test.use({ javaScriptEnabled: false });
	test.skip("server reference in client @nojs", async ({ page }) => {
		await testServerAction2(page, { js: false });
	});
});

async function testServerAction2(page: Page, options: { js: boolean }) {
	await page.goto(url("/"));
	if (options.js) {
		await page.getByText("[hydrated: 1]").click();
	}
	await page.locator('input[name="x"]').fill("2");
	await page.locator('input[name="y"]').fill("3");
	await page.locator('input[name="y"]').press("Enter");
	await expect(page.getByTestId("calculator-answer")).toContainText("5");
	await page.locator('input[name="x"]').fill("2");
	await page.locator('input[name="y"]').fill("three");
	await page.locator('input[name="y"]').press("Enter");
	await expect(page.getByTestId("calculator-answer")).toContainText(
		"(invalid input)",
	);
	if (options.js) {
		await expect(page.locator('input[name="x"]')).toHaveValue("2");
		await expect(page.locator('input[name="y"]')).toHaveValue("three");
	} else {
		await expect(page.locator('input[name="x"]')).toHaveValue("");
		await expect(page.locator('input[name="y"]')).toHaveValue("");
	}
}

test.describe("SSR error fallback (__NO_HYDRATE)", () => {
	test("recovers via CSR when SSR fails", async ({ page }) => {
		await page.goto(url("/ssr-error-fallback"));
		// The client component throws during SSR, so the server renders an error shell
		// with self.__NO_HYDRATE=1. The browser detects this and uses createRoot instead
		// of hydrateRoot, allowing the component to render successfully via CSR.
		await expect(page.getByTestId("ssr-recovered")).toContainText(
			"Recovered via CSR",
		);
	});

	test("sets __NO_HYDRATE flag on globalThis", async ({ page }) => {
		await page.goto(url("/ssr-error-fallback"));
		// Wait for CSR recovery first — this confirms the bootstrap script ran
		await expect(page.getByTestId("ssr-recovered")).toBeVisible();
		// The bootstrap script set self.__NO_HYDRATE=1, which persists on globalThis
		const hasFlag = await page.evaluate(() => Reflect.has(globalThis, "__NO_HYDRATE"));
		expect(hasFlag).toBe(true);
	});

	test("normal page HTML does not contain __NO_HYDRATE", async ({
		request,
	}) => {
		const response = await request.get(`${baseURL}/`);
		expect(response.status()).toBe(200);
		const html = await response.text();
		expect(html).not.toContain("__NO_HYDRATE");
	});
});

test.describe("RSC client-only API errors @dev", () => {
	test("useState in server component shows actionable error message", async () => {
		const response = await fetch(`${baseURL}${basePath}/usestate-in-rsc`, {
			headers: { accept: "text/html" },
		});
		expect(response.status).toBe(500);
		const html = await response.text();
		expect(html).toContain("useState only works in Client Components");
		expect(html).toContain("use client");
	});
});

test.describe("server component throws error", () => {
	test("returns 500 with __NO_HYDRATE and error in flight data", async () => {
		const response = await fetch(`${baseURL}${basePath}/rsc-error`, {
			headers: { accept: "text/html" },
		});
		expect(response.status).toBe(500);
		const html = await response.text();
		expect(html).toContain("__NO_HYDRATE");
		expect(html).toContain(
			"<noscript>500<!-- --> Internal Server Error</noscript>",
		);
		expect(html).toContain("Server component error");
	});

	test("dev shows vite error overlay with error message @dev", async ({
		page,
	}) => {
		await page.goto(url("/rsc-error"));
		const hasFlag = await page.evaluate(() => Reflect.has(globalThis, "__NO_HYDRATE"));
		expect(hasFlag).toBe(true);
		// In dev, ErrorBoundary rethrows → window.onerror → vite-error-overlay
		const overlay = page.locator("vite-error-overlay");
		await expect(overlay).toBeAttached();
		const overlayText = await overlay.evaluate(
			(el: Element) => el.shadowRoot?.textContent ?? "",
		);
		expect(overlayText).toContain("Server component error");
	});
});

test.describe("client component throws during render (SSR)", () => {
	test("returns 500 with __NO_HYDRATE", async () => {
		// ClientComponentThrows throws unconditionally. RSC succeeds (it's a client
		// reference), but SSR fails when rendering the component on the server.
		const response = await fetch(`${baseURL}${basePath}/client-error`, {
			headers: { accept: "text/html" },
		});
		expect(response.status).toBe(500);
		const html = await response.text();
		expect(html).toContain("__NO_HYDRATE");
		expect(html).toContain(
			"<noscript>500<!-- --> Internal Server Error</noscript>",
		);
	});

	test("dev shows vite error overlay with error message @dev", async ({
		page,
	}) => {
		await page.goto(url("/client-error"));
		const overlay = page.locator("vite-error-overlay");
		await expect(overlay).toBeAttached();
		const overlayText = await overlay.evaluate(
			(el: Element) => el.shadowRoot?.textContent ?? "",
		);
		expect(overlayText).toContain("Client component error");
	});

	test("browser recovers via CSR when client component only throws during SSR", async ({
		page,
	}) => {
		// ThrowsDuringSSR only throws on the server (typeof window === 'undefined').
		// The __NO_HYDRATE fallback uses createRoot, so the component renders
		// successfully in the browser without hydration mismatch.
		await page.goto(url("/ssr-error-fallback"));
		await expect(page.getByTestId("ssr-recovered")).toContainText(
			"Recovered via CSR",
		);
		const hasFlag = await page.evaluate(() => Reflect.has(globalThis, "__NO_HYDRATE"));
		expect(hasFlag).toBe(true);
		// The layout shell is fully rendered by the browser — proves CSR recovery works
		await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
		await expect(page.getByRole("link", { name: "Other" })).toBeVisible();
	});
});

test.describe("route handler returns Error (not throws)", () => {
	test("API route returning Error behaves like throwing it (500)", async () => {
		const response = await fetch(`${baseURL}${basePath}/api/returns-error`);
		expect(response.status).toBe(500);
		const body = await response.json();
		expect(body.message).toBe("api handler returned an error");
	});

	test("API route returning Error with status property uses that status", async () => {
		const response = await fetch(`${baseURL}${basePath}/api/returns-error-with-status`);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.message).toBe("bad request");
		expect(body.status).toBe(400);
	});

	test("page handler returning Error shows error shell like thrown errors", async () => {
		const response = await fetch(`${baseURL}${basePath}/page-returns-error`, {
			headers: { accept: "text/html" },
		});
		expect(response.status).toBe(500);
		const html = await response.text();
		expect(html).toContain("__NO_HYDRATE");
		expect(html).toContain("500<!-- --> Internal Server Error");
		expect(html).toContain("page handler returned an error");
	});
});

test.describe("CSRF protection", () => {
	test("cross-origin POST to action endpoint returns 403 @build", async () => {
		// Origin check is disabled in dev (import.meta.hot is truthy) so this
		// test only runs against the production build.
		// Use Node.js fetch directly — browser fetch cannot override the Origin
		// header (it's a forbidden header). Node.js fetch has no such restriction.
		const response = await fetch(`${baseURL}${basePath}/?__rsc=fake-action-id`, {
			method: "POST",
			headers: { Origin: "https://evil.com" },
			body: "",
		});
		expect(response.status).toBe(403);
		expect(await response.text()).toContain("origin mismatch");
	});

	test("same-origin POST to action endpoint is not blocked by CSRF", async () => {
		const response = await fetch(`${baseURL}${basePath}/?__rsc=fake-action-id`, {
			method: "POST",
			headers: { Origin: baseURL },
			body: "",
		});
		// Should not be 403 — the action ID is fake so it will fail for a different reason,
		// but the CSRF check should pass.
		expect(response.status).not.toBe(403);
	});
});

test.describe("status codes", () => {
	test("sync redirect returns correct status and Location header", async () => {
		const response = await fetch(`${baseURL}${basePath}/top-level-redirect`, {
			redirect: "manual",
		});
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(url("/"));
	});

	test("sync not-found returns 404 status", async () => {
		const response = await fetch(`${baseURL}${basePath}/not-found`);
		expect(response.status).toBe(404);
	});
});

test.describe("CSS loading", () => {
	test("global tailwind CSS is applied", async ({ page }) => {
		await page.goto(url("/css-test"));
		const twEl = page.getByTestId("css-test-tailwind");
		await expect(twEl).toBeVisible();
		// Tailwind v4 uses oklch color space. Verify the computed color is not the default black.
		const color = await twEl.evaluate((el) => getComputedStyle(el).color);
		expect(color).not.toBe("rgb(0, 0, 0)");
		// Verify it contains green-ish oklch value from tailwind's text-green-600
		expect(color).toContain("oklch");
	});

	test("server component CSS is applied", async ({ page }) => {
		await page.goto(url("/css-test"));
		const serverEl = page.getByTestId("css-test-server");
		await expect(serverEl).toBeVisible();
		const color = await serverEl.evaluate((el) => getComputedStyle(el).color);
		expect(color).toBe("rgb(37, 99, 235)");
		const border = await serverEl.evaluate(
			(el) => getComputedStyle(el).borderColor,
		);
		expect(border).toBe("rgb(37, 99, 235)");
	});

	test("client component CSS is applied", async ({ page }) => {
		await page.goto(url("/css-test"));
		const clientEl = page.getByTestId("css-test-client");
		await expect(clientEl).toBeVisible();
		// In dev, client component CSS loads async via Vite's HMR style injection
		// (the element is SSR'd before client JS injects the <style> tag).
		// toHaveCSS auto-retries until the style is applied.
		await expect(clientEl).toHaveCSS("color", "rgb(220, 38, 38)");
		await expect(clientEl).toHaveCSS("border-color", "rgb(220, 38, 38)");
	});

	test("CSS is present in SSR HTML (no FOUC)", async () => {
		const response = await fetch(`${baseURL}${basePath}/css-test`);
		const html = await response.text();
		// The HTML should contain stylesheet link tags
		expect(html).toContain('rel="stylesheet"');
	});
});

test.describe("layout stability during navigation", () => {
	test("layout client component is not remounted on navigation", async ({
		page,
	}) => {
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();
		// Layout useEffect ran once on mount
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1");
		// Increment the layout counter to create client state we can track
		const layoutCounter = page
			.getByTestId("client-counter")
			.filter({ hasText: "Layout counter" });
		await layoutCounter.getByRole("button", { name: "+" }).click();
		await layoutCounter.getByText("Layout counter: 1").click();
		// Navigate to another page via client-side Link
		await page.getByRole("link", { name: "Other" }).click();
		await expect(page).toHaveURL(url("/other"));
		// Layout mount count should still be 1 (useEffect did not re-run)
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1");
		// Layout counter state should be preserved (component was not remounted)
		await expect(layoutCounter.getByText("Layout counter: 1")).toBeVisible();
		// Navigate back to home
		await page.getByRole("link", { name: "Home" }).click();
		await expect(page).toHaveURL(url("/"));
		// Still no remount
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1");
		await expect(layoutCounter.getByText("Layout counter: 1")).toBeVisible();
	});
});

test.describe("router.refresh", () => {
	test("refresh updates server data without remounting client components", async ({
		page,
	}) => {
		await page.goto(url("/router-refresh-state"));
		await expect(page.getByTestId("router-refresh-mount-count")).toHaveText("1", {
			timeout: 10000,
		});

		await page.getByTestId("router-refresh-increment").click();
		await expect(page.getByTestId("router-refresh-client-count")).toHaveText("1");

		const serverRenderCount = await page
			.getByTestId("router-refresh-server-render-count")
			.textContent();
		const serverRandom = await page
			.getByTestId("router-refresh-server-random")
			.textContent();

		await page.getByTestId("router-refresh-button").click();

		// Server data updates after refresh
		await expect(
			page.getByTestId("router-refresh-server-render-count"),
		).not.toHaveText(serverRenderCount ?? "", {
			timeout: 10000,
		});
		await expect(page.getByTestId("router-refresh-server-random")).not.toHaveText(
			serverRandom ?? "",
		);
		// Client state preserved (no remount)
		await expect(page.getByTestId("router-refresh-mount-count")).toHaveText("1");
		await expect(page.getByTestId("router-refresh-client-count")).toHaveText("1");
	});
});

test.describe("streaming async generator", () => {
	test("client renders items incrementally before generator completes", async ({
		page,
	}) => {
		// Use waitUntil:'commit' so Playwright doesn't wait for the full streaming response
		await page.goto(url("/streaming"), { waitUntil: "commit" });
		// First item should appear while the generator is still yielding
		const firstItem = page.getByTestId("stream-item").first();
		await expect(firstItem).toBeVisible({ timeout: 10000 });
		await expect(firstItem).toHaveText("message-1");
		// Wait for all items to arrive
		await expect(page.getByTestId("stream-done")).toBeVisible({
			timeout: 10000,
		});
		const items = page.getByTestId("stream-item");
		await expect(items).toHaveCount(3);
		await expect(items.nth(0)).toHaveText("message-1");
		await expect(items.nth(1)).toHaveText("message-2");
		await expect(items.nth(2)).toHaveText("message-3");
	});
});

test.describe("throw response status codes", () => {
	test("throw redirect in page returns 307 and Location header", async () => {
		const response = await fetch(`${baseURL}${basePath}/throw-redirect-in-page`, {
			redirect: "manual",
		});
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(url("/other"));
	});

	test("return redirect in page returns 307 and Location header", async () => {
		const response = await fetch(`${baseURL}${basePath}/return-redirect-in-page`, {
			redirect: "manual",
		});
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(url("/other"));
	});

	test("throw redirect in layout returns 307 and Location header", async () => {
		const response = await fetch(`${baseURL}${basePath}/throw-redirect-in-layout`, {
			redirect: "manual",
		});
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(url("/other"));
	});

	test("throw redirect after async operation returns 307 and Location header", async () => {
		const response = await fetch(`${baseURL}${basePath}/slow-redirect`, {
			redirect: "manual",
		});
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(url("/"));
	});

	test("throw redirect in layout child route returns 307", async () => {
		const response = await fetch(`${baseURL}${basePath}/throw-redirect-in-layout/nested`, {
			redirect: "manual",
		});
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(url("/other"));
	});

	test("throw redirect in layout on unmatched route still redirects", async () => {
		const response = await fetch(
			`${baseURL}${basePath}/throw-redirect-in-layout/does-not-exist`,
			{
				redirect: "manual",
				headers: { "sec-fetch-dest": "document" },
			},
		);
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(url("/other"));
	});

	test("throw notFound in layout on unmatched route still returns 404", async () => {
		const response = await fetch(
			`${baseURL}${basePath}/throw-notfound-in-layout/does-not-exist`,
			{ headers: { "sec-fetch-dest": "document" } },
		);
		expect(response.status).toBe(404);
	});

	test("throw notFound in layout child route returns 404", async () => {
		const response = await fetch(`${baseURL}${basePath}/throw-notfound-in-layout/nested`);
		expect(response.status).toBe(404);
	});

	test("throw notFound in page returns 404", async () => {
		const response = await fetch(`${baseURL}${basePath}/throw-notfound-in-page`);
		expect(response.status).toBe(404);
	});

	test("return notFound in page returns 404", async () => {
		const response = await fetch(`${baseURL}${basePath}/return-notfound-in-page`);
		expect(response.status).toBe(404);
	});

	test("return response in page returns raw 403 response", async () => {
		const response = await fetch(`${baseURL}${basePath}/return-response-in-page`);
		expect(response.status).toBe(403);
		expect(await response.text()).toBe("forbidden");
	});

	test("throw notFound in layout returns 404", async () => {
		const response = await fetch(`${baseURL}${basePath}/throw-notfound-in-layout`);
		expect(response.status).toBe(404);
	});

	test("throw notFound in page renders 404 page for browser request", async ({
		page,
	}) => {
		const response = await page.goto(url("/throw-notfound-in-page"));
		expect(response?.status()).toBe(404);
		await expect(page.getByText("404")).toBeVisible();
		await expect(page.getByText("This page could not be found.")).toBeVisible();
	});

	test("return notFound in page renders 404 page for browser request", async ({
		page,
	}) => {
		const response = await page.goto(url("/return-notfound-in-page"));
		expect(response?.status()).toBe(404);
		await expect(page.getByText("404")).toBeVisible();
		await expect(page.getByText("This page could not be found.")).toBeVisible();
	});

	test("return response in page serves raw 403 document for browser request", async ({
		page,
	}) => {
		const response = await page.goto(url("/return-response-in-page"));
		expect(response?.status()).toBe(403);
		await expect(page.locator("body")).toHaveText("forbidden");
	});

	test("throw notFound in layout renders 404 page for browser request", async ({
		page,
	}) => {
		const response = await page.goto(url("/throw-notfound-in-layout"));
		expect(response?.status()).toBe(404);
		await expect(page.getByText("404")).toBeVisible();
		await expect(page.getByText("This page could not be found.")).toBeVisible();
	});
});

test.describe("client-side navigation with throw response", () => {
	test("throw redirect in page navigates to target", async ({ page }) => {
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();
		await page.getByTestId("link-throw-redirect-page").click();
		await expect(page).toHaveURL(url("/other"));
	});

	test("return redirect in page navigates to target", async ({ page }) => {
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();
		await page.getByTestId("link-return-redirect-page").click();
		await expect(page).toHaveURL(url("/other"));
	});

	test("throw redirect in layout navigates to target", async ({ page }) => {
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();
		await page.getByTestId("link-throw-redirect-layout").click();
		await expect(page).toHaveURL(url("/other"));
	});

	test("throw notFound in page renders 404 page and preserves URL", async ({
		page,
	}) => {
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();
		await page.getByTestId("link-throw-notfound-page").click();
		await expect(page.getByText("404")).toBeVisible();
		await expect(page.getByText("This page could not be found.")).toBeVisible();
		await expect(page).toHaveURL(url("/throw-notfound-in-page"));
	});

	test("return notFound in page renders 404 page and preserves URL", async ({
		page,
	}) => {
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();
		await page.getByTestId("link-return-notfound-page").click();
		await expect(page.getByText("404")).toBeVisible();
		await expect(page.getByText("This page could not be found.")).toBeVisible();
		await expect(page).toHaveURL(url("/return-notfound-in-page"));
	});

	test("return response in page navigates to raw 403 document", async ({ page }) => {
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();
		await page.getByTestId("link-return-response-page").click();
		await expect(page).toHaveURL(url("/return-response-in-page"));
		await expect(page.locator("body")).toHaveText("forbidden");
	});

	test("throw notFound in layout renders 404 page and preserves URL", async ({
		page,
	}) => {
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();
		await page.getByTestId("link-throw-notfound-layout").click();
		await expect(page.getByText("404")).toBeVisible();
		await expect(page.getByText("This page could not be found.")).toBeVisible();
		await expect(page).toHaveURL(url("/throw-notfound-in-layout"));
	});

	test("layout state is preserved after client-side redirect from page", async ({
		page,
	}) => {
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();
		const layoutCounter = page
			.getByTestId("client-counter")
			.filter({ hasText: "Layout counter" });
		await layoutCounter.getByRole("button", { name: "+" }).click();
		await expect(layoutCounter.getByText("Layout counter: 1")).toBeVisible();
		await page.getByTestId("link-throw-redirect-page").click();
		await expect(page).toHaveURL(url("/other"));
		await expect(layoutCounter.getByText("Layout counter: 1")).toBeVisible();
	});

	test("layout state is preserved after client-side redirect from layout", async ({
		page,
	}) => {
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();
		const layoutCounter = page
			.getByTestId("client-counter")
			.filter({ hasText: "Layout counter" });
		await layoutCounter.getByRole("button", { name: "+" }).click();
		await expect(layoutCounter.getByText("Layout counter: 1")).toBeVisible();
		await page.getByTestId("link-throw-redirect-layout").click();
		await expect(page).toHaveURL(url("/other"));
		await expect(layoutCounter.getByText("Layout counter: 1")).toBeVisible();
	});
});

test.describe("router.push() follows .get() 302 redirect via client-side navigation", () => {
	test("router.push to .get() redirect navigates to target without full reload", async ({
		page,
	}) => {
		await page.goto(url("/get-redirect-nav"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1");

		// Set a sentinel on window to detect full page reloads
		const sentinel = Math.random().toString(36);
		await page.evaluate((s) => {
			(window as any).__hmrSentinel = s;
		}, sentinel);

		await page.getByTestId("get-redirect-push").click();

		// Should navigate to the redirect target
		await expect(page.getByTestId("get-redirect-target")).toBeVisible({
			timeout: 10_000,
		});
		await expect(page).toHaveURL(url("/get-redirect/123/target"));

		// Sentinel should still exist — no full page reload happened
		const survivedReload = await page.evaluate(
			(s) => (window as any).__hmrSentinel === s,
			sentinel,
		);
		expect(survivedReload).toBe(true);
	});

	test("layout state is preserved after .get() redirect", async ({ page }) => {
		await page.goto(url("/get-redirect-nav"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1");

		// Increment layout counter to create trackable client state
		const layoutCounter = page
			.getByTestId("client-counter")
			.filter({ hasText: "Layout counter" });
		await layoutCounter.getByRole("button", { name: "+" }).click();
		await expect(layoutCounter.getByText("Layout counter: 1")).toBeVisible();

		await page.getByTestId("get-redirect-push").click();

		// Target page should render
		await expect(page.getByTestId("get-redirect-target")).toBeVisible({
			timeout: 10_000,
		});

		// Layout state should be preserved (SPA navigation, not hard reload)
		await expect(layoutCounter.getByText("Layout counter: 1")).toBeVisible();
	});
});

test.describe("slow throw response (>50ms) still works via client-side fallback", () => {
	test("slow redirect navigates to target via client-side", async ({
		page,
	}) => {
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();
		await page.getByTestId("link-slow-redirect").click();
		await expect(page).toHaveURL(url("/"));
	});

	test("slow notFound renders 404 page via client-side", async ({ page }) => {
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();
		await page.getByTestId("link-slow-notfound").click();
		await expect(page.getByText("404")).toBeVisible();
		await expect(page.getByText("This page could not be found.")).toBeVisible();
		await expect(page).toHaveURL(url("/slow-notfound"));
	});
});

test.describe("soft 404 during client-side navigation (no hard reload)", () => {
	test("layout state is preserved when navigating to a 404 page", async ({
		page,
	}) => {
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();

		// Create layout state we can track
		const layoutCounter = page
			.getByTestId("client-counter")
			.filter({ hasText: "Layout counter" });
		await layoutCounter.getByRole("button", { name: "+" }).click();
		await expect(layoutCounter.getByText("Layout counter: 1")).toBeVisible();

		// Set a sentinel to detect full page reloads
		await page.evaluate(() => {
			Reflect.set(window, "__softNavSentinel", true);
		});

		// Navigate to a route that throws notFound() — should be a soft navigation
		await page.getByTestId("link-throw-notfound-page").click();
		await expect(page.getByText("404")).toBeVisible();
		await expect(page.getByText("This page could not be found.")).toBeVisible();

		// Layout state should be preserved (no hard reload happened)
		await expect(layoutCounter.getByText("Layout counter: 1")).toBeVisible();

		// Sentinel should still be present — proves no full page reload
		const sentinel = await page.evaluate(
			() => Reflect.get(window, "__softNavSentinel"),
		);
		expect(sentinel).toBe(true);
	});

	test("can navigate away from 404 page back to a working page", async ({
		page,
	}) => {
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();

		// Navigate to 404 page
		await page.getByTestId("link-throw-notfound-page").click();
		await expect(page.getByText("404")).toBeVisible();

		// Navigate back to home — should work without a hard reload
		await page.getByRole("link", { name: "Home" }).click();
		await expect(page).toHaveURL(url("/"));
		await expect(page.getByText("Server counter:")).toBeVisible();
	});
});

test.describe("soft server error during client-side navigation", () => {
	test("layout state is preserved when navigating to a page with server error @build", async ({
		page,
	}) => {
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();

		// Create layout state we can track
		const layoutCounter = page
			.getByTestId("client-counter")
			.filter({ hasText: "Layout counter" });
		await layoutCounter.getByRole("button", { name: "+" }).click();
		await expect(layoutCounter.getByText("Layout counter: 1")).toBeVisible();

		// Set a sentinel to detect full page reloads
		await page.evaluate(() => {
			Reflect.set(window, "__softNavSentinel", true);
		});

		// Navigate to a page that throws a server error
		await page.getByTestId("link-rsc-error").click();

		// Should show an error state in the error boundary, not a hard reload.
		// The error from the flight stream doesn't carry __REACT_SERVER_ERROR__ digest,
		// so the inner error boundary renders the inline error page.
		await expect(page.getByText("Application Error")).toBeVisible({
			timeout: 5000,
		});

		// Layout state should be preserved
		await expect(layoutCounter.getByText("Layout counter: 1")).toBeVisible();

		// Sentinel should still be present
		const sentinel = await page.evaluate(
			() => Reflect.get(window, "__softNavSentinel"),
		);
		expect(sentinel).toBe(true);
	});
});

test.describe("navigation abort controller", () => {
	test("rapid navigation aborts the stale RSC fetch", async ({ page }) => {
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();

		// Track RSC requests and their outcomes
		const rscRequests: { url: string; aborted: boolean }[] = [];
		page.on("requestfailed", (req) => {
			if (req.url().includes(".rsc")) {
				rscRequests.push({
					url: req.url(),
					aborted: req.failure()?.errorText === "net::ERR_ABORTED",
				});
			}
		});
		page.on("requestfinished", (req) => {
			if (req.url().includes(".rsc")) {
				rscRequests.push({ url: req.url(), aborted: false });
			}
		});

		// Navigate to slow page (100ms delay), then immediately navigate to /other.
		await page.getByRole("link", { name: "slow page" }).click();
		await page.getByRole("link", { name: "Other" }).click();

		// Should land on /other
		await expect(page).toHaveURL(url("/other"));

		// The slow page RSC fetch should have been aborted (poll until abort is recorded)
		await expect
			.poll(() => rscRequests.find((r) => r.url.includes("/slow")), {
				timeout: 2000,
			})
			.toBeTruthy();
		const slowRequest = rscRequests.find((r) => r.url.includes("/slow"));
		expect(slowRequest!.aborted).toBe(true);

		// The /other RSC fetch should have completed normally (may take longer over network)
		await expect
			.poll(() => rscRequests.find((r) => r.url.includes("/other")), {
				timeout: 5000,
			})
			.toBeTruthy();
		const otherRequest = rscRequests.find((r) => r.url.includes("/other"));
		expect(otherRequest!.aborted).toBe(false);
	});
});

test.describe("error boundary auto-reset on navigation", () => {
	test("error boundary clears when navigating to a new page @build", async ({
		page,
	}) => {
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();

		// Navigate to a page with a server error to trigger the error boundary
		await page.getByTestId("link-rsc-error").click();
		await expect(page.getByText("Application Error")).toBeVisible({
			timeout: 5000,
		});

		// Navigate back to home — error boundary should auto-reset
		await page.getByRole("link", { name: "Home" }).click();
		await expect(page).toHaveURL(url("/"));

		// The error should be gone and normal content should appear
		await expect(page.getByText("Application Error")).not.toBeVisible();
		await expect(page.getByText("Server counter:")).toBeVisible();
	});
});

// Strip non-deterministic parts from RSC/HTML output for stable snapshots:
// client reference IDs (hex hashes) and Vite asset filename hashes.
function stabilize(content: string) {
	return content
		.replace(/I\["[a-f0-9]+"/g, 'I["<REF>"')
		.replace(
			/\/assets\/([a-zA-Z_-]+)-[a-zA-Z0-9_-]+\.(css|js)/g,
			"/assets/$1-<HASH>.$2",
		)
		.replace(/id="_R[a-zA-Z0-9_]*"/g, 'id="_R"')
		.replace(/<script id="_R[a-zA-Z0-9_]*">/g, '<script id="_R">')
		.replace(/import\("[^"]*"\)/g, 'import("<ENTRY>")')
		.replace(
			/(self\.__FLIGHT_DATA\|\|=\[\])\.push\("[^"]*"\)/g,
			"$1.push(<FLIGHT_CHUNK>)",
		);
}

test.describe("prerender", () => {
	test("staticPage renders correctly", async ({ page }) => {
		await page.goto(url("/static/one"));
		await expect(page.getByTestId("static-page")).toBeVisible();
		await expect(
			page.getByText("This is a static page with id one"),
		).toBeVisible();
	});

	test("staticPage renders with different id", async ({ page }) => {
		await page.goto(url("/static/two"));
		await expect(page.getByTestId("static-page")).toBeVisible();
		await expect(
			page.getByText("This is a static page with id two"),
		).toBeVisible();
	});

	test("client navigation to staticPage works", async ({ page }) => {
		await page.goto(url("/prerender-nav"));
		await page.getByTestId("link-static-one").click();
		await expect(page.getByTestId("static-page")).toBeVisible();
		await expect(
			page.getByText("This is a static page with id one"),
		).toBeVisible();
	});
});

test.describe("prerender css", () => {
	test("prerendered page has imported CSS applied", async ({ page }) => {
		await page.goto(url("/static/one"));
		const el = page.getByTestId("static-page");
		await expect(el).toBeVisible();
		await expect(el).toHaveCSS("color", "rgb(22, 163, 74)");
		await expect(el).toHaveCSS("border-color", "rgb(22, 163, 74)");
		await expect(el).toHaveCSS("padding", "12px");
	});

	test("CSS is applied after client navigation to prerendered page", async ({
		page,
	}) => {
		await page.goto(url("/"));
		await expect(page.getByText("Server counter:")).toBeVisible();
		// Navigate to a prerendered page via client-side link
		await page.goto(url("/prerender-nav"));
		await page.getByTestId("link-static-one").click();
		const el = page.getByTestId("static-page");
		await expect(el).toBeVisible();
		await expect(el).toHaveCSS("color", "rgb(22, 163, 74)");
		await expect(el).toHaveCSS("border-color", "rgb(22, 163, 74)");
		await expect(el).toHaveCSS("padding", "12px");
	});
});

test.describe("prerender @build", () => {
	test("prerendered RSC data is served for staticPage", async () => {
		const response = await fetch(baseURL + "/static/one.rsc?__rsc=");
		expect(response.status).toBe(200);
		const contentType = response.headers.get("content-type") ?? "";
		expect(contentType).toContain("text/x-component");
	});

	test("prerendered .rsc file content", async () => {
		const fs = await import("node:fs");
		const raw = fs.readFileSync("dist/client/static/one.rsc", "utf-8");
		// Write to file for debugging instead of snapshots that break on unrelated changes
		fs.writeFileSync(
			"test-results/prerendered-rsc-flight-data.txt",
			stabilize(raw),
		);
		expect(raw.length).toBeGreaterThan(0);
		expect(raw).toContain("static page with id");
	});

	test("prerendered page HTML", async () => {
		const fs = await import("node:fs");
		const response = await fetch(baseURL + "/static/one", {
			headers: { "sec-fetch-dest": "document" },
		});
		expect(response.status).toBe(200);
		const html = await response.text();
		// Write to file for debugging instead of snapshots that break on unrelated changes
		fs.writeFileSync("test-results/prerendered-page-html.txt", stabilize(html));
		expect(html).toContain("static page with id");
		expect(html).toContain("</html>");
	});

	test("prerendered .html files exist on disk", async () => {
		const fs = await import("node:fs");
		expect(fs.existsSync("dist/client/static/one.html")).toBe(true);
		expect(fs.existsSync("dist/client/static/two.html")).toBe(true);
		const html = fs.readFileSync("dist/client/static/one.html", "utf-8");
		expect(html).toContain("static page with id");
		expect(html).toContain("</html>");
	});

	test("prerender manifest includes html paths", async () => {
		const fs = await import("node:fs");
		const manifest = JSON.parse(
			fs.readFileSync("dist/client/__prerender.json", "utf-8"),
		);
		const one = manifest.entries.find(
			(e: { route: string }) => e.route === "/static/one",
		);
		expect(one).toBeTruthy();
		expect(one.html).toBe("/static/one.html");
		expect(one.data).toBe("/static/one.rsc");
	});
});

test.describe("staticGet @build", () => {
	test("staticGet .json file exists on disk after build", async () => {
		const fs = await import("node:fs");
		expect(fs.existsSync("dist/client/api/staticfile.json")).toBe(true);
		const content = JSON.parse(
			fs.readFileSync("dist/client/api/staticfile.json", "utf-8"),
		);
		expect(content).toEqual({
			name: "integration-tests",
			version: "1.0.0",
			features: ["rsc", "streaming", "static-get"],
		});
	});

	test("staticGet route is served as static file", async () => {
		const response = await fetch(
			`${baseURL}${basePath}/api/staticfile.json`,
		);
		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json).toEqual({
			name: "integration-tests",
			version: "1.0.0",
			features: ["rsc", "streaming", "static-get"],
		});
	});

	test("prerender manifest includes staticGet entry", async () => {
		const fs = await import("node:fs");
		const manifest = JSON.parse(
			fs.readFileSync("dist/client/__prerender.json", "utf-8"),
		);
		const entry = manifest.entries.find(
			(e: { route: string }) => e.route === "/api/staticfile.json",
		);
		expect(entry).toBeTruthy();
		expect(entry.file).toBe("/api/staticfile.json");
	});
});

test.describe("Takumi standalone tracing @build", () => {
		test("Takumi runtime files resolve from standalone dist/node_modules", () => {
		const tempDir = copyStandaloneDist();
		try {
			const runtime = resolveTakumiRuntimeFromStandalone({ tempDir });
			const distNodeModules = normalizePath(
				realpathSync(join(tempDir, "dist", "node_modules")),
			);

			expect(existsSync(runtime.corePackageJsonPath)).toBe(true);
			expect(existsSync(runtime.nativePackageJsonPath)).toBe(true);
			expect(existsSync(runtime.nativeBinaryPath)).toBe(true);
			expect(runtime.corePackageJsonPath.startsWith(distNodeModules)).toBe(true);
			expect(runtime.nativePackageJsonPath.startsWith(distNodeModules)).toBe(true);
			expect(runtime.nativeBinaryPath.startsWith(distNodeModules)).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("isolated standalone output can render a Takumi image route", async () => {
		const sharp = (await import("sharp")).default;
		const port = await getFreePort();
		const tempDir = copyStandaloneDist();

		const child = spawn("node", ["dist/rsc/index.js"], {
			cwd: tempDir,
			env: { ...process.env, DEBUG_SPICEFLOW: "1", PORT: String(port) },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		try {
			await waitForServer({ child, port });

			const response = await fetch(`http://127.0.0.1:${port}/api/takumi-image`);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("image/png");

			const buffer = Buffer.from(await response.arrayBuffer());
			const metadata = await sharp(buffer).metadata();
			expect(metadata.format).toBe("png");
			expect(metadata.width).toBe(120);
			expect(metadata.height).toBe(60);
		} catch (error) {
			throw new Error(
				`Isolated standalone Takumi render failed. stdout:\n${stdout}\n\nstderr:\n${stderr}`,
				{ cause: error },
			);
		} finally {
			await stopProcess({ child });
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

test.describe("prerender error @build", () => {
	test("build fails with exit code 1 when a static page throws", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "spiceflow-prerender-error-"));
		let stdout = "";
		let stderr = "";
		let exitCode = 0;

		for (const entry of ["package.json", "tsconfig.json", "vite.config.ts", "src"]) {
			cpSync(join(process.cwd(), entry), join(tempDir, entry), {
				recursive: true,
			});
		}
		symlinkSync(
			join(process.cwd(), "node_modules"),
			join(tempDir, "node_modules"),
			"dir",
		);

		try {
			const output = execSync("./node_modules/.bin/vite build", {
				cwd: tempDir,
				env: {
					...process.env,
					STATIC_PAGE_ERROR: "1",
					SPICEFLOW_SKIP_STANDALONE_TRACE: "1",
				},
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 120_000,
			});
			stdout = output;
		} catch (err: any) {
			exitCode = err.status ?? 1;
			stdout = err.stdout ?? "";
			stderr = err.stderr ?? "";
		} finally {
			// Run the negative build in a temp copy so it can't clobber the live
			// dist/ artifacts used by the production-start server later in this suite.
			rmSync(tempDir, { recursive: true, force: true });
		}
		const combined = stdout + "\n" + stderr;
		expect(exitCode).not.toBe(0);
		expect(combined).toContain("static page build error");
	});
});

test.describe("middleware page cache", () => {
	// In-memory page cache doesn't persist across serverless function instances
	test.skip(() => isRemote, "skipped on remote deployments (stateless functions)");
	// Clear cache before each test so they're isolated
	test.beforeEach(async () => {
		await fetch(`${baseURL}${basePath}/api/cache-clear`);
	});

	test("first HTML request is MISS, second is HIT with identical content", async () => {
		const first = await fetch(`${baseURL}${basePath}/cached-page`, {
			headers: { "sec-fetch-dest": "document" },
		});
		expect(first.status).toBe(200);
		expect(first.headers.get("x-cache")).toBe("MISS");
		const firstHtml = await first.text();

		const second = await fetch(`${baseURL}${basePath}/cached-page`, {
			headers: { "sec-fetch-dest": "document" },
		});
		expect(second.status).toBe(200);
		expect(second.headers.get("x-cache")).toBe("HIT");
		const secondHtml = await second.text();

		expect(secondHtml).toBe(firstHtml);
	});

	test("first RSC request is MISS, second is HIT with identical payload", async () => {
		const first = await fetch(`${baseURL}${basePath}/cached-page?__rsc=1`, {
			headers: { accept: "text/x-component" },
		});
		expect(first.status).toBe(200);
		expect(first.headers.get("x-cache")).toBe("MISS");
		const firstPayload = await first.text();

		const second = await fetch(`${baseURL}${basePath}/cached-page?__rsc=1`, {
			headers: { accept: "text/x-component" },
		});
		expect(second.status).toBe(200);
		expect(second.headers.get("x-cache")).toBe("HIT");
		const secondPayload = await second.text();

		expect(secondPayload).toBe(firstPayload);
	});

	test("HTML and RSC caches are separate (different cache keys)", async () => {
		const html = await fetch(`${baseURL}${basePath}/cached-page`, {
			headers: { "sec-fetch-dest": "document" },
		});
		expect(html.headers.get("x-cache")).toBe("MISS");

		const rsc = await fetch(`${baseURL}${basePath}/cached-page?__rsc=1`, {
			headers: { accept: "text/x-component" },
		});
		expect(rsc.headers.get("x-cache")).toBe("MISS");

		const htmlAgain = await fetch(`${baseURL}${basePath}/cached-page`, {
			headers: { "sec-fetch-dest": "document" },
		});
		expect(htmlAgain.headers.get("x-cache")).toBe("HIT");

		const rscAgain = await fetch(`${baseURL}${basePath}/cached-page?__rsc=1`, {
			headers: { accept: "text/x-component" },
		});
		expect(rscAgain.headers.get("x-cache")).toBe("HIT");
	});

	test("cached page renders correctly in browser", async ({ page }) => {
		await page.goto(url("/cached-page"));
		await expect(page.getByTestId("cached-page")).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "Cached Page" }),
		).toBeVisible();
		await expect(page.getByTestId("cached-render-count")).toHaveText("1");
	});

	test("cached page serves same content on reload (render count stays 1)", async ({
		page,
	}) => {
		await page.goto(url("/cached-page"));
		await expect(page.getByTestId("cached-render-count")).toHaveText("1");
		const firstRandom = await page.getByTestId("cached-random").textContent();

		await page.reload();
		await expect(page.getByTestId("cached-render-count")).toHaveText("1");
		const secondRandom = await page.getByTestId("cached-random").textContent();
		expect(secondRandom).toBe(firstRandom);
	});

	test("client-side navigation to cached page returns cached RSC payload", async ({
		page,
	}) => {
		// Start on home — has [hydrated: 1] marker for confirming JS is ready
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();

		// First client-side nav to cached page — should be MISS (primes RSC cache)
		let rscResponsePromise = page.waitForResponse(
			(res) => res.url().includes("cached-page") && res.url().includes("__rsc"),
		);
		await page.getByTestId("link-cached-page").click();
		let rscResponse = await rscResponsePromise;
		expect(rscResponse.headers()["x-cache"]).toBe("MISS");
		await expect(page.getByTestId("cached-page")).toBeVisible();
		const primeRandom = await page.getByTestId("cached-random").textContent();

		// Navigate back home
		await page.getByTestId("cached-page-home-link").click();
		await expect(page).toHaveURL(url("/"));

		// Second client-side nav — should be HIT
		rscResponsePromise = page.waitForResponse(
			(res) => res.url().includes("cached-page") && res.url().includes("__rsc"),
		);
		await page.getByTestId("link-cached-page").click();
		rscResponse = await rscResponsePromise;
		expect(rscResponse.headers()["x-cache"]).toBe("HIT");

		// Content should match what was cached (same random value)
		await expect(page.getByTestId("cached-page")).toBeVisible();
		const navRandom = await page.getByTestId("cached-random").textContent();
		expect(navRandom).toBe(primeRandom);
	});

	test("client-side nav from layout link uses cached RSC payload", async ({
		page,
	}) => {
		// Start on home page
		await page.goto(url("/"));
		await page.getByText("[hydrated: 1]").click();

		// First client-side nav — primes RSC cache (MISS)
		let rscResponsePromise = page.waitForResponse(
			(res) => res.url().includes("cached-page") && res.url().includes("__rsc"),
		);
		await page.getByTestId("link-cached-page").click();
		let rscResponse = await rscResponsePromise;
		expect(rscResponse.headers()["x-cache"]).toBe("MISS");
		await expect(page.getByTestId("cached-page")).toBeVisible();

		// Navigate back home
		await page.getByRole("link", { name: "Home", exact: true }).click();
		await expect(page).toHaveURL(url("/"));

		// Second nav — should be HIT
		rscResponsePromise = page.waitForResponse(
			(res) => res.url().includes("cached-page") && res.url().includes("__rsc"),
		);
		await page.getByTestId("link-cached-page").click();
		rscResponse = await rscResponsePromise;
		expect(rscResponse.headers()["x-cache"]).toBe("HIT");

		await expect(page.getByTestId("cached-page")).toBeVisible();
	});
});

test.describe("deployment id @build", () => {
	test("document response does not set deployment cookie", async () => {
		const response = await fetch(baseURL + "/", {
			headers: { "sec-fetch-dest": "document" },
		});
		const setCookie = response.headers.get("set-cookie") ?? "";
		// Deployment cookie was removed — deployment ID is available via
		// getDeploymentId() but no longer sent as a cookie.
		expect(setCookie).not.toContain("spiceflow-deployment=");
	});
});

test.describe("server actions", () => {
	test("simple server action called from client returns value", async ({
		page,
	}) => {
		await page.goto(url("/server-action-simple"));
		// Wait for hydration (layout mount tracker increments from 0 to 1)
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await page.getByTestId("call-simple-action").click();
		await expect(page.getByTestId("simple-action-result")).toHaveText(
			"echo: hello",
			{ timeout: 10000 },
		);
	});

	test("server action returning async generator streams items incrementally", async ({
		page,
	}) => {
		await page.goto(url("/server-action-streaming"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await page.getByTestId("start-streaming").click();
		// First item should appear before the generator completes
		const firstItem = page.getByTestId("action-stream-item").first();
		await expect(firstItem).toBeVisible({ timeout: 10000 });
		await expect(firstItem).toHaveText("chunk-1");
		// Wait for completion
		await expect(page.getByTestId("action-stream-done")).toBeVisible({
			timeout: 10000,
		});
		const items = page.getByTestId("action-stream-item");
		await expect(items).toHaveCount(3);
		await expect(items.nth(0)).toHaveText("chunk-1");
		await expect(items.nth(1)).toHaveText("chunk-2");
		await expect(items.nth(2)).toHaveText("chunk-3");
	});

	test("server action returning JSX renders on the client", async ({
		page,
	}) => {
		await page.goto(url("/server-action-jsx"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await page.getByTestId("call-jsx-action").click();
		const result = page.getByTestId("server-jsx-result");
		await expect(result).toBeVisible({ timeout: 10000 });
		await expect(result.locator("h1")).toHaveText("Hello Tommy");
		await expect(result.locator("p")).toHaveText("Rendered on the server");
	});

	test("server action returning async generator of JSX streams elements", async ({
		page,
	}) => {
		await page.goto(url("/server-action-jsx-streaming"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await page.getByTestId("start-jsx-streaming").click();
		// First chunk should appear before generator completes
		const firstChunk = page.getByTestId("jsx-stream-chunk").first();
		await expect(firstChunk).toBeVisible({ timeout: 10000 });
		await expect(firstChunk).toHaveText("chunk-jsx-1");
		// Wait for completion
		await expect(page.getByTestId("jsx-stream-done")).toBeVisible({
			timeout: 10000,
		});
		const chunks = page.getByTestId("jsx-stream-chunk");
		await expect(chunks).toHaveCount(3);
		await expect(chunks.nth(0)).toHaveText("chunk-jsx-1");
		await expect(chunks.nth(1)).toHaveText("chunk-jsx-2 bold");
		await expect(chunks.nth(2)).toHaveText("chunk-jsx-3");
		// Verify the second chunk has the bold element
		await expect(chunks.nth(1).locator("strong")).toHaveText("bold");
	});

	test("server action async generator that throws propagates error to client with message", async ({
		page,
	}) => {
		await page.goto(url("/server-action-throwing-streaming"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await page.getByTestId("start-throwing-streaming").click();
		// Should receive the item yielded before the error
		const items = page.getByTestId("throwing-stream-item");
		await expect(items.first()).toHaveText("before-error", {
			timeout: 10000,
		});
		// Error should propagate with the original message
		const errorEl = page.getByTestId("throwing-stream-error");
		await expect(errorEl).toBeVisible({ timeout: 10000 });
		await expect(errorEl).toHaveText("generator exploded");
	});

	test("form action with useActionState submits and returns result", async ({
		page,
	}) => {
		await page.goto(url("/form"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await page.locator('input[name="name"]').fill("test");
		await page.getByRole("button", { name: "Submit" }).click();
		await expect(page.locator("pre")).toContainText('"result":"ok"', {
			timeout: 10000,
		});
	});

	test("server action called directly preserves client component state", async ({
		page,
	}) => {
		await page.goto(url("/server-action-simple"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		// Increment the layout counter to set some client state
		const layoutCounter = page
			.getByTestId("client-counter")
			.filter({ hasText: "Layout" });
		await layoutCounter.getByRole("button", { name: "+" }).click();
		await expect(layoutCounter).toContainText("Layout counter: 1");
		// Call the server action
		await page.getByTestId("call-simple-action").click();
		await expect(page.getByTestId("simple-action-result")).toHaveText(
			"echo: hello",
			{ timeout: 10000 },
		);
		// Layout counter state should be preserved after server action
		await expect(layoutCounter).toContainText("Layout counter: 1");
	});

	test("throw redirect() in server action navigates to target", async ({
		page,
	}) => {
		await page.goto(url("/form-redirect"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await page.locator('input[name="name"]').fill("test");
		await page.getByRole("button", { name: "Submit" }).click();
		await expect(page).toHaveURL(url("/"), { timeout: 10000 });
	});

	test("throw Error in server action propagates to client", async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (err) => errors.push(err.message));
		await page.goto(url("/form-error"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await page.locator('input[name="name"]').fill("test");
		await page.getByRole("button", { name: "Submit" }).click();
		// The error reaches the client as a pageerror or shows in the error boundary
		await expect
			.poll(
				async () => {
					const bodyText = await page.evaluate(
						() => document.body?.textContent ?? "",
					);
					return (
						errors.some((e) => e.includes("test error")) ||
						bodyText.includes("test error") ||
						bodyText.includes("Application Error")
					);
				},
				{ timeout: 5000 },
			)
			.toBe(true);
	});

	test("inline 'use server' with closure revalidates the page after form submit", async ({
		page,
	}) => {
		// All server action calls (form submissions and direct calls) re-render
		// the page tree so server-rendered content updates automatically.
		test.skip(isRemote, "stateless functions");
		const errors: string[] = [];
		page.on("pageerror", (err) => errors.push(err.message));
		await page.goto(url("/inline-action-with-closure"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		const countBefore = await page
			.getByTestId("inline-action-render-count")
			.textContent();
		await page.locator('input[name="name"]').fill("world");
		await page.getByRole("button", { name: "Submit" }).click();
		// After the form action completes, the page should revalidate
		// (re-render on server), so the render count increments.
		await expect(page.getByTestId("inline-action-render-count")).not.toHaveText(
			countBefore!,
			{ timeout: 10000 },
		);
		expect(errors).toEqual([]);
	});

	test("direct server action throwing redirect navigates to target", async ({
		page,
	}) => {
		await page.goto(url("/server-action-redirect"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await page.getByTestId("call-redirect-action").click();
		await expect(page).toHaveURL(url("/other"), { timeout: 10000 });
	});

	test("direct server action redirect preserves layout state", async ({
		page,
	}) => {
		await page.goto(url("/server-action-redirect"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		// Set some client state in the layout counter
		const layoutCounter = page
			.getByTestId("client-counter")
			.filter({ hasText: "Layout" });
		await layoutCounter.getByRole("button", { name: "+" }).click();
		await expect(layoutCounter).toContainText("Layout counter: 1");
		// Redirect via server action
		await page.getByTestId("call-redirect-action").click();
		await expect(page).toHaveURL(url("/other"), { timeout: 10000 });
		// Layout state should be preserved (client-side navigation, not full reload)
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1");
	});

	test("direct server action redirect adds a browser history entry", async ({
		page,
	}) => {
		test.skip(isRemote, "cross-origin localhost redirect needs local server");
		await page.goto(url("/server-action-redirect"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await page.getByTestId("call-external-redirect-action").click();
		// The redirect target is 127.0.0.1 (cross-origin from localhost).
		// In prod, Node binds to 0.0.0.0, so the page loads at 127.0.0.1.
		// In dev, Vite binds to localhost only, so the browser shows chrome-error.
		// Both prove location.assign was used (not location.replace).
		await expect(page).toHaveURL(
			/127\.0\.0\.1.*\/other|chrome-error:\/\/chromewebdata\//,
			{ timeout: 10000 },
		);
		await page.goBack();
		await expect(page).toHaveURL(url("/server-action-redirect"), {
			timeout: 10000,
		});
	});

	test("direct server action redirect with set-cookie preserves cookie", async ({
		page,
	}) => {
		await page.goto(url("/server-action-redirect"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await page.getByTestId("call-redirect-cookie-action").click();
		await expect(page).toHaveURL(url("/other"), { timeout: 10000 });
		// The set-cookie header from the redirect should have been applied
		const cookies = await page.context().cookies();
		const actionCookie = cookies.find((c) => c.name === "action-redirect");
		expect(actionCookie?.value).toBe("1");
	});

	test("wrapped client form action redirect renders target page", async ({
		page,
	}) => {
		await page.goto(url("/wrapped-server-action-redirect"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await page.locator('input[name="name"]').fill("new-org");
		await page.getByRole("button", { name: "Create item" }).click();
		await expect(page).toHaveURL(url("/wrapped-server-action-redirect/new-org"), {
			timeout: 10000,
		});
		await expect(page.getByTestId("wrapped-redirect-target")).toHaveText(
			"Created new-org",
			{ timeout: 10000 },
		);
		await expect(page.getByTestId("wrapped-redirect-form")).toHaveCount(0);
	});

	test("form action with useActionState returns result to the page", async ({
		page,
	}) => {
		await page.goto(url("/form-action-test"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await page.getByTestId("action-form-input").fill("hello world");
		await page.getByTestId("action-form-submit").click();
		await expect(page.getByTestId("action-form-result")).toHaveText(
			"Received: hello world",
			{ timeout: 10000 },
		);
	});

	test("form action error preserves error message in error boundary", async ({
		page,
	}) => {
		await page.goto(url("/form-action-error-test"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await page.getByTestId("action-form-input").fill("test");
		await page.getByTestId("action-form-submit").click();
		// The thrown error message must be visible on the page via the error boundary,
		// not just a generic "Application Error"
		await expect(
			page.getByText("Action failed: invalid input", { exact: true }),
		).toBeVisible({ timeout: 10000 });
	});

	test("form action error triggers app onError exactly once for callServer requests", async ({ page }) => {
		// JS-enabled form actions still surface the action error through the
		// client error boundary, but the server-side onError hook should report
		// the failure exactly once for monitoring.
		const resetResponse = await fetch(`${baseURL}${basePath}/api/on-error-reset`);
		expect(resetResponse.status).toBe(200);
		expect(await resetResponse.json()).toEqual({ count: 0 });

		await page.goto(url("/form-action-error-test"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await page.getByTestId("action-form-input").fill("test");
		await page.getByTestId("action-form-submit").click();
		await expect(
			page.getByText("Action failed: invalid input", { exact: true }),
		).toBeVisible({ timeout: 10000 });

		const countResponse = await fetch(`${baseURL}${basePath}/api/on-error-count`);
		expect(countResponse.status).toBe(200);
		expect(await countResponse.json()).toEqual({ count: 1 });
	});

	test("ErrorBoundary shows error message and reset button when form action throws", async ({
		page,
	}) => {
		await page.goto(url("/error-boundary-form-test"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		// Form should be visible, error container should not
		await expect(page.getByTestId("eb-form")).toBeVisible();
		// Submit with "fail" to trigger the server error
		await page.getByTestId("eb-form-input").fill("fail");
		await page.getByTestId("eb-form-submit").click();
		// ErrorBoundary should catch and show the error message
		await expect(page.getByTestId("eb-error-message")).toHaveText(
			"Validation failed: bad input",
			{ timeout: 10000 },
		);
		// Reset button should be visible
		await expect(page.getByTestId("eb-reset-button")).toBeVisible();
		// Clicking reset should restore the form
		await page.getByTestId("eb-reset-button").click();
		await expect(page.getByTestId("eb-form")).toBeVisible({ timeout: 5000 });
	});

	test("ErrorBoundary reset allows resubmitting form successfully after error", async ({
		page,
	}) => {
		await page.goto(url("/error-boundary-form-test"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		// Trigger error first
		await page.getByTestId("eb-form-input").fill("fail");
		await page.getByTestId("eb-form-submit").click();
		await expect(page.getByTestId("eb-error-message")).toHaveText(
			"Validation failed: bad input",
			{ timeout: 10000 },
		);
		// Reset
		await page.getByTestId("eb-reset-button").click();
		await expect(page.getByTestId("eb-form")).toBeVisible({ timeout: 5000 });
		// Submit with valid input (not "fail") — should not show error
		await page.getByTestId("eb-form-input").fill("valid");
		await page.getByTestId("eb-form-submit").click();
		// Form should still be visible (action succeeds), no error container
		await expect(page.getByTestId("eb-form")).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId("eb-error-container")).not.toBeVisible();
	});

	test("ErrorBoundary below keeps form visible and interactive alongside error", async ({
		page,
	}) => {
		await page.goto(url("/error-boundary-inline-test"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await expect(page.getByTestId("inline-eb-form")).toBeVisible();
		// Trigger the error
		await page.getByTestId("inline-eb-form-input").fill("fail");
		await page.getByTestId("inline-eb-form-submit").click();
		// Error should appear below the form
		await expect(page.getByTestId("inline-eb-error-message")).toHaveText(
			"Inline boundary: action failed",
			{ timeout: 10000 },
		);
		// Form should STILL be visible and interactive
		await expect(page.getByTestId("inline-eb-form")).toBeVisible();
		// User can fix the input and resubmit without clicking reset
		await page.getByTestId("inline-eb-form-input").fill("valid");
		await page.getByTestId("inline-eb-form-submit").click();
		await expect(page.getByTestId("inline-eb-form")).toBeVisible({ timeout: 5000 });
		// Error should auto-clear after a successful submission
		await expect(page.getByTestId("inline-eb-error-container")).not.toBeVisible({ timeout: 10000 });
		// Reset button also works to clear the error manually
		await page.getByTestId("inline-eb-form-input").fill("fail");
		await page.getByTestId("inline-eb-form-submit").click();
		await expect(page.getByTestId("inline-eb-error-message")).toBeVisible({ timeout: 10000 });
		await page.getByTestId("inline-eb-reset-button").click();
		await expect(page.getByTestId("inline-eb-error-container")).not.toBeVisible({ timeout: 5000 });
	});

	test("ErrorBoundary.ErrorMessage truncates long messages and supports expand/collapse", async ({
		page,
	}) => {
		await page.goto(url("/error-boundary-long-message"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await page.getByTestId("eb-form-input").fill("fail");
		await page.getByTestId("eb-form-submit").click();
		// ErrorBoundary should show
		await expect(page.getByTestId("eb-error-message")).toBeVisible({ timeout: 10000 });
		// Should have pre-wrap whitespace
		const whiteSpace = await page.getByTestId("eb-error-message").evaluate(
			(el) => getComputedStyle(el).whiteSpace,
		);
		expect(whiteSpace).toBe("pre-wrap");
		// The message has 30 lines, default maxLines is 10, so "Show more" should appear
		const showMore = page.getByTestId("eb-error-container").getByText("Show more");
		await expect(showMore).toBeVisible();
		// Click "Show more" to expand
		await showMore.click();
		// Now "Show less" should appear
		await expect(
			page.getByTestId("eb-error-container").getByText("Show less"),
		).toBeVisible();
		// Line 30 should now be visible in the expanded message
		await expect(page.getByTestId("eb-error-message")).toContainText("Line 30");
	});

	test("parseFormData ValidationError is caught by ErrorBoundary", async ({
		page,
	}) => {
		await page.goto(url("/parse-form-data-error-boundary"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		// Form is visible initially
		await expect(page.getByTestId("pfd-eb-form")).toBeVisible();
		// Submit with empty name and invalid email to trigger ValidationError
		await page.getByTestId("pfd-eb-name").fill("");
		await page.getByTestId("pfd-eb-email").fill("not-an-email");
		await page.getByTestId("pfd-eb-submit").click();
		// ErrorBoundary should catch the ValidationError and show the message
		await expect(page.getByTestId("pfd-eb-error-message")).toBeVisible({ timeout: 10000 });
		const errorText = await page.getByTestId("pfd-eb-error-message").textContent();
		// The ValidationError message contains the Zod validation messages
		expect(errorText).toBeTruthy();
		expect(errorText!.length).toBeGreaterThan(0);
		// Reset should restore the form
		await page.getByTestId("pfd-eb-reset-button").click();
		await expect(page.getByTestId("pfd-eb-form")).toBeVisible({ timeout: 5000 });
		// Submit with valid data — should not trigger error
		await page.getByTestId("pfd-eb-name").fill("Alice");
		await page.getByTestId("pfd-eb-email").fill("alice@example.com");
		await page.getByTestId("pfd-eb-submit").click();
		// Form should remain visible, no error
		await expect(page.getByTestId("pfd-eb-form")).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId("pfd-eb-error-container")).not.toBeVisible();
	});

	test("parseFormData validates and coerces form fields with schema", async ({
		page,
	}) => {
		await page.goto(url("/parse-form-data-test"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		// Fill in the form fields
		await page.getByTestId("pfd-name").fill("Alice");
		await page.getByTestId("pfd-age").fill("25");
		// Select multiple tags
		await page.getByTestId("pfd-tags").selectOption(["a", "c"]);
		await page.getByTestId("pfd-submit").click();
		// The action returns a formatted string with coerced values
		await expect(page.getByTestId("pfd-result")).toHaveText(
			"name=Alice, age=25, tags=a+c",
			{ timeout: 10000 },
		);
	});

	test("parseFormData returns validation error on invalid input", async ({
		page,
	}) => {
		await page.goto(url("/parse-form-data-test"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		// Submit with empty name (min 1 char required)
		await page.getByTestId("pfd-name").fill("");
		await page.getByTestId("pfd-age").fill("25");
		await page.getByTestId("pfd-submit").click();
		// The action catches ValidationError and returns it as "error:..."
		await expect(page.getByTestId("pfd-result")).toContainText("error:", {
			timeout: 10000,
		});
	});

	test("getActionAbortController aborts an in-flight server action", async ({
		page,
	}) => {
		await page.goto(url("/server-action-abort"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		// Initial state
		await expect(page.getByTestId("action-state")).toHaveText("idle");
		await expect(page.getByTestId("action-pending")).toHaveText("false");
		// Start the slow action (sleeps 100s on server)
		await page.getByTestId("start-slow-action").click();
		// Wait for pending state
		await expect(page.getByTestId("action-pending")).toHaveText("true", {
			timeout: 5000,
		});
		// Abort it via getActionAbortController
		await page.getByTestId("abort-slow-action").click();
		// The useActionState wrapper catches AbortError and returns "aborted"
		await expect(page.getByTestId("action-state")).toHaveText("aborted", {
			timeout: 10000,
		});
		// Pending should go back to false
		await expect(page.getByTestId("action-pending")).toHaveText("false", {
			timeout: 10000,
		});
	});

	test("getActionRequest returns request with url, method, and signal inside server action", async ({
		page,
	}) => {
		await page.goto(url("/server-action-inspect-request"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await page.getByTestId("call-inspect-request").click();
		await expect(page.getByTestId("inspect-request-state")).not.toHaveText(
			"idle",
			{ timeout: 10000 },
		);
		const raw = await page.getByTestId("inspect-request-state").textContent();
		const result = JSON.parse(raw!);
		expect(result.method).toBe("POST");
		expect(result.hasSignal).toBe(true);
		expect(result.url).toContain("__rsc=");
	});

	test("getActionRequest body is not locked after spiceflow consumes it", async ({
		page,
	}) => {
		await page.goto(url("/server-action-read-body"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});
		await page.getByRole("button", { name: "Read Body" }).click();
		// The action reads request.text() on the request from getActionRequest().
		// Spiceflow already consumed the body to decode args, so this should
		// either return empty string or not throw a ReadableStream locked error.
		await expect(page.getByTestId("action-body-result")).toHaveText("ok", {
			timeout: 10000,
		});
	});
});

test.describe("federated payloads", () => {
	test("decodeFederationPayload decodes route response and hydrates client components", async ({
		page,
	}) => {
		await page.goto(url("/federated-payload-decode"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});

		const layoutCounter = page
			.getByTestId("client-counter")
			.filter({ hasText: "Layout" });
		await layoutCounter.getByRole("button", { name: "+" }).click();
		await expect(layoutCounter).toContainText("Layout counter: 1");

		await page.getByTestId("decode-federated-payload").click();

		await expect(page.getByTestId("decoded-federated-message")).toHaveText(
			"decoded via decodeFederationPayload",
			{ timeout: 10000 },
		);

		const decodedCounter = page
			.getByTestId("decoded-federated-content")
			.getByTestId("client-counter");
		await expect(decodedCounter).toContainText("Imperative counter: 0", {
			timeout: 10000,
		});
		await decodedCounter.getByRole("button", { name: "+" }).click();
		await expect(decodedCounter).toContainText("Imperative counter: 1");

		await expect(layoutCounter).toContainText("Layout counter: 1");
	});

	test("decodeFederationPayload preserves async iterable object fields from route responses", async ({
		page,
	}) => {
		await page.goto(url("/federated-payload-decode"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});

		await page.getByTestId("decode-federated-stream").click();

		await expect(page.getByTestId("decoded-federated-stream")).toContainText(
			"Stream item 1",
			{ timeout: 10000 },
		);

		await expect(page.getByTestId("decoded-federated-stream-item")).toHaveCount(3, {
			timeout: 10000,
		});
		await expect(page.getByTestId("decoded-federated-stream")).toContainText(
			"Stream item 2",
		);
		await expect(page.getByTestId("decoded-federated-stream")).toContainText(
			"Stream item 3",
		);
		await expect(page.getByTestId("decoded-federated-stream-done")).toHaveText(
			"done",
		);
	});

	test("decodeFederationPayload preserves JSX inside async iterable items", async ({
		page,
	}) => {
		await page.goto(url("/federated-payload-decode"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});

		await page.getByTestId("decode-federated-jsx-stream").click();

		await expect(page.getByTestId("decoded-federated-jsx-stream")).toContainText(
			"JSX stream item 1",
			{ timeout: 10000 },
		);
		await expect(page.getByTestId("decoded-federated-jsx-stream-item")).toHaveCount(
			3,
			{ timeout: 10000 },
		);
		await expect(page.getByTestId("decoded-federated-jsx-stream")).toContainText(
			"JSX stream item 2",
		);
		await expect(page.getByTestId("decoded-federated-jsx-stream")).toContainText(
			"line 200",
		);
		await expect(
			page.getByTestId("decoded-federated-stream-jsx-content"),
		).toHaveText("JSX item");
		await expect(page.getByTestId("decoded-federated-jsx-stream")).toContainText(
			"JSX stream item 3",
		);
		await expect(page.getByTestId("decoded-federated-jsx-stream-done")).toHaveText(
			"done",
		);
	});

	test("RenderFederatedPayload renders same-process response and hydrates client components", async ({
		page,
	}) => {
		await page.goto(url("/render-federated-payload"));
		await expect(page.getByTestId("layout-mount-count")).toHaveText("1", {
			timeout: 10000,
		});

		const counter = page
			.getByTestId("render-federated-payload-test")
			.getByTestId("client-counter");
		await expect(counter).toContainText("SSR counter: 0", {
			timeout: 10000,
		});
		await counter.getByRole("button", { name: "+" }).click();
		await expect(counter).toContainText("SSR counter: 1");
	});

	test("renderToStaticMarkup renders JSX inside the RSC environment", async () => {
		const response = await fetch(baseURL + url("/api/render-html-string"));
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(await response.text()).toBe(
			'<section data-email="welcome"><h1>Welcome, Ada</h1><p>Your invite code is 1234.</p></section>',
		);
	});
});

test.describe("loaders", () => {
	test("wildcard loader data is passed to page via ctx.loaderData (SSR)", async ({
		page,
	}) => {
		await page.goto(url("/loader-test"));
		const serverData = await page
			.getByTestId("loader-data-server")
			.textContent();
		const parsed = JSON.parse(serverData!);
		expect(parsed.global).toBe("from-wildcard-loader");
	});

	test("wildcard + exact loaders merge for nested page (SSR)", async ({
		page,
	}) => {
		await page.goto(url("/loader-test/nested"));
		const serverData = await page
			.getByTestId("loader-data-server")
			.textContent();
		const parsed = JSON.parse(serverData!);
		expect(parsed.global).toBe("from-wildcard-loader");
		expect(parsed.nested).toBe("from-nested-loader");
	});

	test("only wildcard loader matches for pages without exact loader (SSR)", async ({
		page,
	}) => {
		await page.goto(url("/loader-test/other"));
		const serverData = await page
			.getByTestId("loader-data-server")
			.textContent();
		const parsed = JSON.parse(serverData!);
		expect(parsed.global).toBe("from-wildcard-loader");
		expect(parsed.nested).toBeUndefined();
	});

	test("useLoaderData hook renders loader data on client after hydration", async ({
		page,
	}) => {
		await page.goto(url("/loader-test"));
		await expect(page.getByTestId("loader-data-client")).toBeVisible({
			timeout: 10000,
		});
		const clientData = await page
			.getByTestId("loader-data-client")
			.textContent();
		const parsed = JSON.parse(clientData!);
		expect(parsed.global).toBe("from-wildcard-loader");
	});

	test("useLoaderData shows merged data for nested page after hydration", async ({
		page,
	}) => {
		await page.goto(url("/loader-test/nested"));
		await expect(page.getByTestId("loader-data-client")).toBeVisible({
			timeout: 10000,
		});
		const clientData = await page
			.getByTestId("loader-data-client")
			.textContent();
		const parsed = JSON.parse(clientData!);
		expect(parsed.global).toBe("from-wildcard-loader");
		expect(parsed.nested).toBe("from-nested-loader");
	});

	test("client-side navigation updates loader data", async ({ page }) => {
		await page.goto(url("/loader-nav-start"));
		// Wait for hydration
		await expect(page.getByTestId("link-loader-nested")).toBeVisible({
			timeout: 10000,
		});

		// Navigate to nested (has wildcard + exact loaders)
		await page.getByTestId("link-loader-nested").click();
		await expect(page).toHaveURL(url("/loader-test/nested"), { timeout: 10000 });
		await expect(page.getByTestId("loader-data-client")).toBeVisible({
			timeout: 10000,
		});
		const nestedData = await page
			.getByTestId("loader-data-client")
			.textContent();
		const nestedParsed = JSON.parse(nestedData!);
		expect(nestedParsed.global).toBe("from-wildcard-loader");
		expect(nestedParsed.nested).toBe("from-nested-loader");

		// Navigate to /loader-test/other (only wildcard loader)
		await page.getByTestId("link-loader-other").click();
		await expect(page).toHaveURL(url("/loader-test/other"), { timeout: 10000 });
		// Wait for server data to update (confirms we got new page render)
		await expect(page.getByTestId("loader-data-server")).toContainText(
			"from-wildcard-loader",
			{ timeout: 10000 },
		);
		// Client data should only have wildcard loader, not nested
		await expect(async () => {
			const otherData = await page
				.getByTestId("loader-data-client")
				.textContent();
			const otherParsed = JSON.parse(otherData!);
			expect(otherParsed.global).toBe("from-wildcard-loader");
			expect(otherParsed.nested).toBeUndefined();
		}).toPass({ timeout: 10000 });
	});

	test("client-side navigation from non-loader page to loader page gets data", async ({
		page,
	}) => {
		await page.goto(url("/loader-nav-start"));
		await expect(page.getByTestId("link-loader-test")).toBeVisible({
			timeout: 10000,
		});

		await page.getByTestId("link-loader-test").click();
		await expect(page).toHaveURL(url("/loader-test"), { timeout: 10000 });
		await expect(page.getByTestId("loader-data-client")).toBeVisible({
			timeout: 10000,
		});
		const data = await page.getByTestId("loader-data-client").textContent();
		const parsed = JSON.parse(data!);
		expect(parsed.global).toBe("from-wildcard-loader");
	});

	test("server and client loader data match on initial load", async ({
		page,
	}) => {
		await page.goto(url("/loader-test/nested"));
		await expect(page.getByTestId("loader-data-client")).toBeVisible({
			timeout: 10000,
		});

		const serverData = await page
			.getByTestId("loader-data-server")
			.textContent();
		const clientData = await page
			.getByTestId("loader-data-client")
			.textContent();
		expect(JSON.parse(serverData!)).toEqual(JSON.parse(clientData!));
	});

	test("throw redirect in loader returns 307 and Location header", async () => {
		const response = await fetch(`${baseURL}${basePath}/loader-redirect`, {
			redirect: "manual",
		});
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(url("/other"));
	});

	test("return redirect in loader returns 307 and Location header", async () => {
		const response = await fetch(`${baseURL}${basePath}/loader-redirect-return`, {
			redirect: "manual",
		});
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(url("/other"));
	});

	test("throw notFound in loader returns 404", async () => {
		const response = await fetch(`${baseURL}${basePath}/loader-notfound`);
		expect(response.status).toBe(404);
	});

	test("return notFound in loader returns 404", async () => {
		const response = await fetch(`${baseURL}${basePath}/loader-notfound-return`);
		expect(response.status).toBe(404);
	});

	test("throw redirect in loader navigates via browser", async ({ page }) => {
		const response = await page.goto(url("/loader-redirect"));
		expect(page.url()).toContain("/other");
	});

	test("throw notFound in loader returns 404 in browser", async ({ page }) => {
		const response = await page.goto(url("/loader-notfound"));
		expect(response?.status()).toBe(404);
	});

	test("throw error in loader renders error boundary", async ({ page }) => {
		const response = await page.goto(url("/loader-error"));
		expect(response?.status()).toBe(500);
		// Error boundary should catch the loader error and render an error UI
		// instead of a blank page or raw 500. The page content "should not render"
		// must NOT appear.
		const text = await page.textContent("body");
		expect(text).not.toContain("should not render");
	});

	test("router.getLoaderData resolves with correct data after hydration", async ({
		page,
	}) => {
		await page.goto(url("/loader-test/global"));
		await expect(page.getByTestId("read-loader-data")).toBeVisible({
			timeout: 10000,
		});
		await expect(async () => {
			await page.getByTestId("read-loader-data").click();
			const data = await page.getByTestId("subscribe-data-live").textContent();
			expect(data).toBeTruthy();
			expect(JSON.parse(data!)).toMatchObject({
				global: "from-wildcard-loader",
			});
		}).toPass({ timeout: 10000 });
	});

	test("router.getLoaderData updates after client-side navigation", async ({
		page,
	}) => {
		// Start on a page with loader data, expose router.getLoaderData on window
		await page.goto(url("/loader-test/global"));
		await expect(page.getByTestId("link-global-nested")).toBeVisible({
			timeout: 10000,
		});

		// Navigate to nested page (has wildcard + exact loaders)
		await page.getByTestId("link-global-nested").click();
		await expect(page).toHaveURL(url("/loader-test/nested"), { timeout: 10000 });

		await expect(page.getByTestId("read-loader-data")).toBeVisible({
			timeout: 10000,
		});
		await page.getByTestId("read-loader-data").click();
		await expect(async () => {
			const clientData = await page
				.getByTestId("subscribe-data-live")
				.textContent();
			const parsed = JSON.parse(clientData!);
			expect(parsed.global).toBe("from-wildcard-loader");
			expect(parsed.nested).toBe("from-nested-loader");
		}).toPass({ timeout: 10000 });
	});
});

// TODO: fix upstream — URLSearchParams normalizes ?raw to ?raw= which breaks
// Vite's rawRE = /(\?|&)raw(?:&|$)/ asset plugin filter. The load hook never
// fires, so import-analysis tries to parse the raw .md as JS and fails.
// See: https://github.com/vitejs/vite/issues/XXXXX
test.describe("?raw import", () => {
	test.fixme("page with ?raw .md import renders content without error overlay", async ({
		page,
	}) => {
		await page.goto(url("/raw-import-test"));
		await expect(page.getByTestId("raw-import-content")).toContainText(
			"# Test Content",
		);
		await expect(page.getByTestId("raw-import-content")).toContainText(
			"This is a **markdown** file",
		);
		// No Vite error overlay should appear
		const overlay = page.locator("vite-error-overlay");
		await expect(overlay).not.toBeAttached({ timeout: 2000 });
	});

	test.fixme("?raw import returns correct content via fetch", async () => {
		const res = await fetch(`${baseURL}${basePath}/raw-import-test`);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("# Test Content");
		expect(html).toContain("This is a **markdown** file");
	});
});

test.describe(".server.ts file guard", () => {
	test("page renders normally when .server.ts is not imported from client @dev", async ({
		page,
	}) => {
		await page.goto(url("/server-guard-test"));
		await expect(page.getByTestId("server-guard-test")).toContainText(
			"server guard ok",
		);
	});

	test("importing .server.ts from client component shows error @dev", async ({
		page,
	}) => {
		// Load any page to establish HMR connection, then dynamically import
		// the bad module. The resolveId hook throws during import analysis in
		// the client environment. The terminal shows "Server-only module
		// referenced by client"; the browser overlay shows the module fetch failure.
		await page.goto(url("/server-guard-test"));
		await expect(page.getByTestId("server-guard-test")).toContainText(
			"server guard ok",
		);
		// Trigger client-env resolution by importing the module from the browser.
		// Must include basePath so the import resolves under Vite's base URL.
		const importPath = `${basePath}/src/app/bad-server-import-client.tsx`;
		const importError = await page.evaluate(async (p) => {
			try {
				await import(/* @vite-ignore */ p);
				return null;
			} catch (error) {
				return String(error instanceof Error ? error.message : error);
			}
		}, importPath);

		if (typeof importError === "string" && importError.length > 0) {
			expect(importError).toContain("bad-server-import-client");
			return;
		}

		const overlay = page.locator("vite-error-overlay");
		await expect(overlay).toBeAttached({ timeout: 10000 });
		const overlayText = await overlay.evaluate(
			(el: Element) => el.shadowRoot?.textContent ?? "",
		);
		expect(overlayText).toContain("bad-server-import-client.tsx");
	});
});

test.describe("spiceflow dirs", () => {
	test("publicDir and distDir resolve to correct paths in dev @dev", async ({
		page,
	}) => {
		await page.goto(url("/spiceflow-dirs"));
		await expect(page.getByTestId("public-dir")).toHaveText("public");
		await expect(page.getByTestId("dist-dir")).toHaveText(".");
	});

	test("publicDir and distDir resolve to correct paths in prod @build", async ({
		page,
	}) => {
		await page.goto(url("/spiceflow-dirs"));
		await expect(page.getByTestId("public-dir")).toHaveText("dist/client");
		await expect(page.getByTestId("dist-dir")).toHaveText("dist");
	});

	test("useId produces matching IDs between SSR and client hydration", async ({
		page,
	}) => {
		const warnings: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "warning" || msg.type() === "error") {
				warnings.push(msg.text());
			}
		});

		// Fetch SSR HTML and extract the data-id attribute
		const ssrResponse = await fetch(baseURL + url("/use-id-test"));
		const ssrHtml = await ssrResponse.text();
		const ssrIdMatch = ssrHtml.match(/data-id="([^"]+)"/);
		expect(ssrIdMatch).toBeTruthy();
		const ssrId = ssrIdMatch![1];

		// Navigate to the page and wait for hydration
		await page.goto(url("/use-id-test"));
		const el = page.getByTestId("use-id-test");
		await expect(el).toBeVisible();

		// Get the hydrated ID
		const hydratedId = await el.getAttribute("data-id");
		expect(hydratedId).toBe(ssrId);

		// Check no hydration mismatch warnings
		const hydrationWarnings = warnings.filter(
			(w) =>
				w.includes("hydration") ||
				w.includes("did not match") ||
				w.includes("didn't match"),
		);
		expect(hydrationWarnings).toHaveLength(0);
	});
});

test("router.push with same-origin absolute URL navigates via SPA", async ({
	page,
}) => {
	await page.goto(url("/absolute-url-test"));
	await expect(page.getByTestId("hydrated")).toBeVisible();
	// Set a sentinel to verify no full page reload happens (SPA navigation)
	const sentinel = Math.random().toString(36);
	await page.evaluate((s) => { (window as any).__sentinel = s }, sentinel);
	await page.getByTestId("push-same-origin-absolute").click();
	await expect(page).toHaveURL(new RegExp(`${basePath}/page$`));
	// Sentinel should survive — SPA navigation, not a full reload
	const survived = await page.evaluate((s) => (window as any).__sentinel === s, sentinel);
	expect(survived).toBe(true);
});

test("router.replace with same-origin absolute URL navigates via SPA", async ({
	page,
}) => {
	await page.goto(url("/absolute-url-test"));
	await expect(page.getByTestId("hydrated")).toBeVisible();
	const sentinel = Math.random().toString(36);
	await page.evaluate((s) => { (window as any).__sentinel = s }, sentinel);
	await page.getByTestId("replace-same-origin-absolute").click();
	await expect(page).toHaveURL(new RegExp(`${basePath}/page$`));
	const survived = await page.evaluate((s) => (window as any).__sentinel === s, sentinel);
	expect(survived).toBe(true);
});

test("Link with external href lets browser handle navigation", async ({
	page,
}) => {
	await page.goto(url("/absolute-url-test"));
	const externalLink = page.getByTestId("external-link");
	// External link should have the full external href, not be rewritten
	await expect(externalLink).toHaveAttribute("href", "https://example.com");
	// Clicking should NOT be intercepted by the SPA router.
	// Verify by checking that the link's click handler doesn't call preventDefault.
	const wasDefaultPrevented = await externalLink.evaluate((el) => {
		return new Promise<boolean>((resolve) => {
			el.addEventListener(
				"click",
				(e) => {
					// Check after a microtask to let the React handler run first
					queueMicrotask(() => resolve(e.defaultPrevented));
				},
				{ capture: true, once: true },
			);
			el.click();
		});
	});
	expect(wasDefaultPrevented).toBe(false);
});

test("page with required query params renders without error when params missing", async ({
	page,
}) => {
	// Navigate to a page that has required query params but don't provide them.
	// The page should render (not show a 422 error page).
	await page.goto(url("/page-query-test"));
	await expect(page.getByTestId("page-query-test")).toBeVisible();

	// With valid query params, coerced values are passed to handler
	await page.goto(url("/page-query-test?q=hello&page=2"));
	await expect(page.getByTestId("page-query-test")).toHaveText(
		"q=hello page=2",
	);
});
