import { Suspense, useActionState, useState } from "react";

import { Spiceflow, serveStatic, redirect, parseFormData } from "spiceflow";
import { IndexPage } from "./app/index";
import { getCounter } from "./app/action";

import { Layout } from "./app/layout";
import { StaticPage } from "./app/static-page";
import "./styles.css";

import { ErrorBoundary } from "spiceflow/dist/react/components";

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
import { Chakra } from "./app/chakra";
import {
	ClientComponentThrows,
	ClientFormWithError,
	Counter,
	ErrorInUseEffect,
	ErrorRender,
	RouterPathnameProbe,
	RouterTransitionStateProbe,
	RouterRefreshStateTest,
	GetRedirectNav,
} from "./app/client";
import { DialogDemo } from "./app/dialog";
import { WithSelect } from "./app/select";
import { ThrowsDuringSSR } from "./app/ssr-error";
import { StreamingConsumer } from "./app/streaming-consumer";
import {
	StreamingActionTest,
	SimpleActionTest,
	RedirectActionTest,
	WrappedRedirectFormTest,
	JsxActionTest,
	JsxStreamingActionTest,
	ThrowingStreamingActionTest,
} from "./app/action-test-client";

let inlineActionRenderCount = 0;
import { Head, Link } from "spiceflow/react";
import { CssTestClient } from "./app/client";
import { CssTestServer } from "./app/css-test-server";
import { ScrollTestPage } from "./app/scroll-test";
import {
	LayoutClientContextProvider,
	LayoutClientContextValue,
} from "./app/client-context";
import { LoaderDataDisplay, LoaderNavLinks } from "./app/loader-test-client";
import { ActionBodyTest } from "./app/action-body-test";
import {
	GlobalLoaderDisplay,
	SubscribeDataReader,
} from "./app/loader-global-client";
import { ServerGuardTestClient } from "./app/server-guard-test-client";
import { ActionFormTest } from "./app/action-form-test";
import { ErrorBoundaryFormTest, InlineErrorBoundaryFormTest, ParseFormDataErrorBoundaryTest } from "./app/error-boundary-form-test";
import { UncaughtActionTest } from "./app/uncaught-action-test";
import { ParseFormDataTest } from "./app/parse-form-data-test";
import {
	AbortActionTest,
	InspectRequestActionTest,
} from "./app/abort-test-client";
import ImageResponse from "@takumi-rs/image-response";
import {
	FederatedPayloadDecodeTest,
} from "./app/federated-payload-client";
import { UseIdTest } from "./app/use-id-test";
import { AbsoluteUrlTest } from "./app/absolute-url-test";
import testContentRaw from "./test-content.md?raw";
import { publicDir, distDir } from "spiceflow";
import {
	encodeFederationPayload,
	renderToStaticMarkup,
} from "spiceflow/federation";
import { RenderFederatedPayload } from "spiceflow/react";
import { z } from "zod";
import { PackageRouterPathnameProbe } from "router-state-fixture";

const contactSchema = z.object({
	name: z.string().min(1),
	age: z.number().min(0),
	tags: z.array(z.string()),
});
const contactFields = contactSchema.keyof().enum;

const ebFormSchema = z.object({
	name: z.string().min(1, "Name is required"),
	email: z.string().email("Invalid email address"),
});
const ebFormFields = ebFormSchema.keyof().enum;

// Increments on every RSC render of the home page. Used by e2e tests to detect
// unwanted server re-renders (e.g. client HMR should not trigger a server render).
let serverRenderCount = 0;
let routerRefreshRenderCount = 0;
let onErrorCount = 0;

function getOptionalLabel(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const label = Reflect.get(value, "label");
	if (typeof label !== "string") return undefined;
	return label;
}

async function* createFederatedPayloadStream({
	label,
}: {
	label: string;
}) {
	yield { id: "1", label: `${label} item 1` };
	await sleep(50);
	yield { id: "2", label: `${label} item 2` };
	await sleep(50);
	yield { id: "3", label: `${label} item 3` };
}

async function* createFederatedPayloadJsxStream({
	label,
}: {
	label: string;
}) {
	yield { id: "1", label: `${label} item 1` };
	await sleep(50);
	yield {
		id: "2",
		label: `${label} item 2`,
		output: Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n"),
		content: <strong data-testid="decoded-federated-stream-jsx-content">JSX item</strong>,
	};
	await sleep(50);
	yield { id: "3", label: `${label} item 3` };
}

// In-memory page cache for e2e testing of the README caching middleware pattern.
// Key = pathname+search (naturally separates HTML and RSC responses).
const pageCache = new Map<
	string,
	{ body: string; status: number; headers: [string, string][] }
>();
let cachedPageRenderCount = 0;

function notFound() {
	return new Response(null, { status: 404 });
}

export const app = new Spiceflow()
	.onError(() => {
		onErrorCount++;
	})
	.use(serveStatic({ root: "./public" }))
	.state("middleware1", "")
	.use(async ({ request, state }, next) => {
		state.middleware1 = "state set by middleware1";
		const res = await next();
		res.headers.set("x-middleware-1", "ok");
		res.headers.set(
			"x-middleware-response-type",
			res.headers.get("content-type") || "",
		);

		return res;
	})
	.layout("/*", async ({ children, state }) => {
		return (
			<Layout>
				<Head>
					<Head.Title>title from layout</Head.Title>
				</Head>
				{children ?? (
					<div data-testid="layout-not-found">
						<h1>404</h1>
						<p>This page could not be found.</p>
					</div>
				)}
			</Layout>
		);
	})
	.page("/state", async ({ state }) => {
		return (
			<>
				<Head>
					<Head.Title>title from page</Head.Title>
				</Head>
				state: {state.middleware1}
			</>
		);
	})
	.page("/", async ({ request }) => {
		serverRenderCount++;
		const counter = await getCounter();
		const serverRandom = Math.random().toString(36).slice(2);
		return (
			<>
				<Head>
					<Head.Title>title from page</Head.Title>
				</Head>
				<span data-testid="server-render-count">{serverRenderCount}</span>
				<IndexPage counter={counter} serverRandom={serverRandom} />
			</>
		);
	})
	.page("/router-refresh-state", async () => {
		routerRefreshRenderCount++;
		return (
			<RouterRefreshStateTest
				serverRandom={Math.random().toString(36).slice(2)}
				serverRenderCount={routerRefreshRenderCount}
			/>
		);
	})
	.page("/router-state/deep", async () => {
		return <RouterPathnameProbe />;
	})
	.page("/router-state/package", async () => {
		return <PackageRouterPathnameProbe />;
	})
	.page("/router-state/a", async () => {
		return <RouterTransitionStateProbe to="/router-state/b" />;
	})
	.page("/router-state/b", async () => {
		await sleep(500);
		return <RouterTransitionStateProbe to="/router-state/a" />;
	})

	.get("/hello", () => "Hello, World!")
	.page("/not-found", () => {
		throw notFound();
	})
	.layout("/not-found-in-suspense", async ({ children }) => {
		return <Suspense fallback={<div>not found...</div>}>{children}</Suspense>;
	})
	.page("/not-found-in-suspense", async () => {
		await sleep(10);
		throw notFound();
	})
	.page("/top-level-redirect", async () => {
		throw redirect("/");
	})
	// throw redirect/notFound from layout (not page) — tests that the framework
	// preserves the correct status code even when the throw happens in a layout
	.layout("/throw-redirect-in-layout/*", async ({ children }) => {
		throw redirect("/other");
	})
	.page("/throw-redirect-in-layout", async () => {
		return <div>should not render</div>;
	})
	.page("/throw-redirect-in-layout/nested", async () => {
		return <div>should not render</div>;
	})
	.layout("/throw-notfound-in-layout/*", async ({ children }) => {
		throw notFound();
	})
	.page("/throw-notfound-in-layout", async () => {
		return <div>should not render</div>;
	})
	.page("/throw-notfound-in-layout/nested", async () => {
		return <div>should not render</div>;
	})
	// dedicated pages for client-side navigation tests — separate from the existing
	// routes so the tests stay isolated and don't interfere with other suites
	.page("/throw-redirect-in-page", async () => {
		throw redirect("/other");
	})
	.page("/return-redirect-in-page", async () => {
		return redirect("/other");
	})
	.page("/throw-notfound-in-page", async () => {
		throw notFound();
	})
	.page("/return-notfound-in-page", async () => {
		return notFound();
	})
	.page("/return-response-in-page", async () => {
		return new Response("forbidden", {
			status: 403,
			headers: { "content-type": "text/plain;charset=utf-8" },
		});
	})
	.page("/redirect-in-rsc", async () => {
		return <Redirects />;
	})
	.page("/slow-redirect", async ({ request, children }) => {
		await sleep(100);

		throw redirect("/");
	})
	.page("/slow-notfound", async () => {
		await sleep(100);
		throw notFound();
	})

	.page("/redirect-in-rsc-suspense", async () => {
		return (
			<Suspense fallback={<div>redirecting...</div>}>
				<Redirects />
			</Suspense>
		);
	})
	.layout("/response-headers/*", async ({ children, response }) => {
		response.headers.set("x-layout-header", "layout");
		return <>{children}</>;
	})
	.page("/response-headers", async ({ response }) => {
		response.headers.set("cache-control", "private, max-age=60");
		response.headers.set("x-page-header", "page");
		response.headers.append("set-cookie", "page-cookie=1; Path=/; HttpOnly");
		return <div data-testid="response-headers-page">response headers page</div>;
	})
	.page("/response-headers/redirect", async ({ response }) => {
		response.headers.append(
			"set-cookie",
			"before-redirect=1; Path=/; HttpOnly",
		);
		throw redirect("/response-target");
	})
	.page("/response-target", async () => {
		return <div data-testid="response-target-page">response target</div>;
	})
	.page("/response-nav", async () => {
		return (
			<div>
				<Link href="/response-headers" data-testid="response-nav-link">
					Go to response headers page
				</Link>
			</div>
		);
	})
	.layout("/layout-client-context/*", async ({ children }) => {
		return (
			<LayoutClientContextProvider value="from-layout-client-provider">
				{children}
			</LayoutClientContextProvider>
		);
	})
	.page("/layout-client-context", async () => {
		return <LayoutClientContextValue />;
	})
	.page("/layout-client-context-nav", async () => {
		return (
			<div>
				<Link
					href="/layout-client-context"
					data-testid="layout-client-context-nav-link"
				>
					Go to layout client context page
				</Link>
			</div>
		);
	})
	.layout("/app/*", async ({ children }) => {
		return (
			<section data-testid="app-layout">
				<h1>App layout</h1>
				{children}
			</section>
		);
	})
	.page("/app", async () => {
		return <div data-testid="app-page">App index page</div>;
	})
	.page("/app/settings", async () => {
		return <div data-testid="app-settings-page">App settings page</div>;
	})
	.layout("/docs/*", async ({ children }) => {
		return (
			<section data-testid="docs-layout">
				<h1>Docs layout</h1>
				{children}
			</section>
		);
	})
	.layout("/duplicate-layout/*", async ({ children }) => {
		return <section data-testid="duplicate-layout-a">{children}</section>;
	})
	.layout("/duplicate-layout/*", async ({ children }) => {
		return <section data-testid="duplicate-layout-b">{children}</section>;
	})
	.page("/duplicate-layout", async () => {
		return <div data-testid="duplicate-layout-page">Duplicate layout page</div>;
	})
	.page("/docs", async () => {
		return <div data-testid="docs-page">Docs index page</div>;
	})
	.page("/docs/getting-started", async () => {
		return (
			<div data-testid="docs-getting-started-page">Docs getting started page</div>
		);
	})
	.layout("/page/*", async ({ request, children }) => {
		return (
			<div className="">
				<h1>/page layout 1</h1>
				{children}
			</div>
		);
	})
	.page("/slow", async ({ request, children }) => {
		await sleep(100);
		return (
			<div className="">
				<h1>this is a slow page</h1>
			</div>
		);
	})
	.layout("/slow-suspense", async ({ request, children }) => {
		return (
			<div className="">
				<h1>/slow-suspense layout</h1>
				<Suspense fallback={<div>Loading slow page layout...</div>}>
					{children}
				</Suspense>
			</div>
		);
	})
	.page("/slow-suspense", async ({ request, children }) => {
		await sleep(100);
		return (
			<div className="">
				<h1>slow page</h1>
			</div>
		);
	})
	.page("/form-server", async ({ state, children }) => {
		async function action(data: FormData) {
			"use server";
			if (!state) {
				throw new Error("userId not set");
			}

			return;
		}

		return (
			<form action={action} className="">
				<input name="name" className="border" type="text" />
				<button type="submit">Submit</button>
			</form>
		);
	})
	.page("/form-error", async ({ request, children }) => {
		return <ClientFormWithError shouldError />;
	})
	.page("/form", async ({ request, children }) => {
		return <ClientFormWithError />;
	})
	.page("/form-redirect", async ({ request, children }) => {
		return <ClientFormWithError shouldRedirect />;
	})
	.page("/form-inline-action-server", async ({ state, children }) => {
		async function action(formState) {
			"use server";
			console.log({ state });
			return {
				...formState,
				result: JSON.stringify({ state, hello: true }),
			};
		}
		return <ClientFormWithError action={action} shouldRedirect />;
	})
	.layout("/page/*", async ({ request, children }) => {
		return (
			<div className="">
				<h1>/page layout 2</h1>
				{children}
			</div>
		);
	})
	.page("/page", async ({ request }) => {
		const counter = await getCounter();
		const serverRandom = Math.random().toString(36).slice(2);
		return (
			<div>
				<a href="/page/1">/page/1</a>
				<IndexPage counter={counter} serverRandom={serverRandom} />
			</div>
		);
	})
	.page("/page/1", async ({ request }) => {
		const counter = await getCounter();
		const serverRandom = Math.random().toString(36).slice(2);
		return (
			<div>
				<a href="/page">/page</a>
				<IndexPage counter={counter} serverRandom={serverRandom} />
			</div>
		);
	})
	.page("/use-id-test", async () => {
		return <UseIdTest />;
	})
	.page("/:id", async ({ request, params }) => {
		const counter = await getCounter();
		const serverRandom = Math.random().toString(36).slice(2);
		return (
			<div className="">
				<h1>:id page</h1>
				<IndexPage counter={counter} serverRandom={serverRandom} />
			</div>
		);
	})
	.layout("/error-boundary", async ({ children }) => {
		return (
			<ErrorBoundary errorComponent={ErrorRender}>{children}</ErrorBoundary>
		);
	})
	.page("/error-boundary", async () => {
		throw new Error("test error");
	})
	.page("/error-in-use-effect", async () => {
		return <ErrorInUseEffect />;
	})
	.page("/rsc-error", async () => {
		return <ServerComponentThrows />;
	})
	.page("/client-error", async () => {
		return <ClientComponentThrows />;
	})
	.page("/usestate-in-rsc", async () => {
		return <UseStateInServerComponent />;
	})
	.page("/streaming", async () => {
		async function* generateMessages() {
			yield "message-1";
			await sleep(50);
			yield "message-2";
			await sleep(50);
			yield "message-3";
		}
		return <StreamingConsumer stream={generateMessages()} />;
	})
	.page("/ssr-error-fallback", async () => {
		return <ThrowsDuringSSR />;
	})
	.page("/dialog", async () => {
		return <DialogDemo />;
	})
	.page("/chakra", async () => {
		return <Chakra />;
	})
	.page("/select", async () => {
		return <WithSelect />;
	})
	.page("/scroll-restoration/page-a", async () => {
		return <ScrollTestPage name="Page A" />;
	})
	.page("/scroll-restoration/page-b", async () => {
		return <ScrollTestPage name="Page B" />;
	})
	.page("/css-test", async () => {
		return (
			<div data-testid="css-test-page">
				<h1>CSS Test Page</h1>
				<CssTestServer />
				<CssTestClient />
				<div
					data-testid="css-test-tailwind"
					className="text-green-600 border-2 border-green-600 p-2"
				>
					Tailwind styled element
				</div>
			</div>
		);
	})
	.use(async ({ request }, next) => {
		const url = new URL(request.url);
		const segments = url.pathname.split("/");
		const lastSegment = segments[segments.length - 1];
		if (lastSegment !== "cached-page" && lastSegment !== "cached-page.rsc") {
			return next();
		}
		if (request.method !== "GET") {
			return next();
		}
		const cacheKey = `${url.pathname}${url.search}`;
		const cached = pageCache.get(cacheKey);
		if (cached) {
			const headers = new Headers(cached.headers);
			headers.set("x-cache", "HIT");
			return new Response(cached.body, { status: cached.status, headers });
		}
		const response = await next();
		if (!response || response.status !== 200) {
			return response;
		}
		const body = await response.text();
		const headers = new Headers(response.headers);
		headers.set("x-cache", "MISS");
		pageCache.set(cacheKey, {
			body,
			status: response.status,
			headers: [...headers.entries()],
		});
		return new Response(body, { status: response.status, headers });
	})
	.page("/cached-page", async () => {
		cachedPageRenderCount++;
		const timestamp = Date.now();
		const random = Math.random().toString(36).slice(2);
		return (
			<div data-testid="cached-page">
				<h1>Cached Page</h1>
				<span data-testid="cached-render-count">{cachedPageRenderCount}</span>
				<span data-testid="cached-timestamp">{timestamp}</span>
				<span data-testid="cached-random">{random}</span>
				<Link href="/" data-testid="cached-page-home-link">
					Back to Home
				</Link>
			</div>
		);
	})
	.page("/cached-page-nav", async () => {
		return (
			<div>
				<Link href="/cached-page" data-testid="link-to-cached-page">
					Go to cached page
				</Link>
			</div>
		);
	})
	.get("/api/cache-clear", () => {
		pageCache.clear();
		cachedPageRenderCount = 0;
		return { cleared: true };
	})
	.get("/api/on-error-count", () => {
		return { count: onErrorCount };
	})
	.get("/api/on-error-reset", () => {
		onErrorCount = 0;
		return { count: onErrorCount };
	})
	.page("/static/:id", function StaticComponent({ params: { id } }) {
		return <StaticPage id={id} />;
	})
	.page("/prerender-nav", async () => {
		return (
			<div>
				<Link href="/static/one" data-testid="link-static-one">
					Go to static one
				</Link>
				<Link href="/static/two" data-testid="link-static-two">
					Go to static two
				</Link>
			</div>
		);
	})
	.page("/meta", async ({ request }) => {
		return (
			<div className="">
				<Head>
					<Head.Title>Spiceflow Example</Head.Title>
					<Head.Meta name="test" content="value" />
					<Head.Meta name="test" content="value" />
					<Head.Meta property="og:title" content="Spiceflow Example" />
					<Head.Meta
						property="og:description"
						content="An example application built with Spiceflow"
					/>
					<Head.Meta property="og:type" content="website" />
					<Head.Meta property="og:image" content="/og-image.jpg" />
					<Head.Meta property="og:url" content="https://example.com" />
				</Head>
			</div>
		);
	})
	.layout("/meta-override/*", async ({ children }) => {
		return (
			<>
				<Head>
					<Head.Title>Layout title</Head.Title>
					<Head.Meta name="description" content="Layout description" />
					<Head.Meta property="og:title" content="Layout og:title" />
				</Head>
				{children}
			</>
		);
	})
	.page("/meta-override", async () => {
		return (
			<div>
				<Head>
					<Head.Title>Page title</Head.Title>
					<Head.Meta name="description" content="Page description" />
					<Head.Meta property="og:title" content="Page og:title" />
				</Head>
			</div>
		);
	})
	.page("/title-nav-a", async () => {
		return (
			<div>
				<Head>
					<Head.Title>Title A</Head.Title>
				</Head>
				<Link data-testid="title-nav-link" href="/title-nav-b">
					Go to B
				</Link>
			</div>
		);
	})
	.page("/title-nav-b", async () => {
		return (
			<div>
				<Head>
					<Head.Title>Title B</Head.Title>
				</Head>
				<Link data-testid="title-nav-link" href="/title-nav-a">
					Go to A
				</Link>
			</div>
		);
	})

	.page("/server-guard-test", async () => {
		return <ServerGuardTestClient />;
	})
	.page("/page-returns-error", async () => {
		return new Error("page handler returned an error");
	})
	.get("/api/returns-error", () => {
		return new Error("api handler returned an error");
	})
	.get("/api/returns-error-with-status", () => {
		return Object.assign(new Error("bad request"), { status: 400 });
	})
	.post("/echo", async ({ request }) => {
		const body = await request.json();
		return { echo: body };
	})
	.get("/api/hello", () => "Hello from API!")
	.get("/api/setup", () => "setup")
	.get("/api/response-headers", ({ response }) => {
		response.headers.set("x-api-header", "ok");
		response.headers.append("set-cookie", "api-cookie=1; Path=/; HttpOnly");
		return { ok: true };
	})
	.post("/api/echo", async ({ request }) => {
		const body = await request.json();
		return { echo: body };
	})
	.post("/api/federated-payload", async ({ request }) => {
		const label = getOptionalLabel(await request.json());
		return await encodeFederationPayload({
			message: "decoded via decodeFederationPayload",
			content: <Counter name={label ?? "Imperative"} />,
		});
	})
	.post("/api/federated-payload-stream", async ({ request }) => {
		const label = getOptionalLabel(await request.json());
		return await encodeFederationPayload({
			stream: createFederatedPayloadStream({ label: label ?? "Stream" }),
		});
	})
	.post("/api/federated-payload-jsx-stream", async ({ request }) => {
		const label = getOptionalLabel(await request.json());
		return await encodeFederationPayload({
			stream: createFederatedPayloadJsxStream({ label: label ?? "JSX stream" }),
		});
	})
	.get("/api/federated-render", async ({ request }) => {
		const url = new URL(request.url);
		const label = url.searchParams.get("label") ?? "SSR";
		return await encodeFederationPayload(<Counter name={label} />);
	})
	.get("/api/render-html-string", async () => {
		const html = await renderToStaticMarkup(
			<section data-email="welcome">
				<h1>Welcome, Ada</h1>
				<p>Your invite code is 1234.</p>
			</section>,
		);
		return new Response(html, {
			headers: { "content-type": "text/html;charset=utf-8" },
		});
	})
	.page("/federated-payload-decode", async () => {
		return <FederatedPayloadDecodeTest />;
	})
	.page("/render-federated-payload", async ({ request }) => {
		const response = await app.handle(
			new Request(new URL("./api/federated-render?label=SSR", request.url)),
		);
		return (
			<div data-testid="render-federated-payload-test">
				<Suspense
					fallback={<div data-testid="render-federated-loading">loading</div>}
				>
					<RenderFederatedPayload response={response} />
				</Suspense>
			</div>
		);
	})
	.page("/server-action-streaming", async () => {
		return <StreamingActionTest />;
	})
	.page("/server-action-simple", async () => {
		return <SimpleActionTest />;
	})
	.page("/server-action-redirect", async () => {
		return <RedirectActionTest />;
	})
	.page("/wrapped-server-action-redirect", async () => {
		return <WrappedRedirectFormTest />;
	})
	.page("/wrapped-server-action-redirect/:name", async ({ params }) => {
		return (
			<div data-testid="wrapped-redirect-target">Created {params.name}</div>
		);
	})
	.page("/form-redirect-nojs", async () => {
		async function formRedirectAction(formData: FormData) {
			"use server";
			throw redirect("/other");
		}
		return (
			<form action={formRedirectAction} data-testid="nojs-redirect-form">
				<input name="name" type="text" defaultValue="test" />
				<button type="submit">Submit</button>
			</form>
		);
	})
	.page("/server-action-jsx", async () => {
		return <JsxActionTest />;
	})
	.page("/server-action-jsx-streaming", async () => {
		return <JsxStreamingActionTest />;
	})
	.page("/server-action-throwing-streaming", async () => {
		return <ThrowingStreamingActionTest />;
	})
	.page("/server-action-abort", async () => {
		return <AbortActionTest />;
	})
	.page("/server-action-inspect-request", async () => {
		return <InspectRequestActionTest />;
	})
	.page("/server-action-read-body", async () => {
		return <ActionBodyTest />;
	})
	.page("/inline-action-with-closure", async () => {
		let renderCount = inlineActionRenderCount++;
		const closedValue = "just-a-string";
		async function myAction(formData: FormData) {
			"use server";
			const name = formData.get("name");
			return `hello ${name}, state=${closedValue}`;
		}
		return (
			<form action={myAction} data-testid="inline-action-form">
				<input name="name" type="text" defaultValue="world" />
				<button type="submit">Submit</button>
				<div data-testid="inline-action-render-count">{renderCount}</div>
			</form>
		);
	})
	.page("/form-action-test", async () => {
		async function handleSubmit(prev: string, formData: FormData) {
			"use server";
			const message = formData.get("message");
			if (typeof message !== "string") {
				throw new Error("Expected form action message to be a string");
			}
			return `Received: ${message}`;
		}
		return <ActionFormTest action={handleSubmit} />;
	})
	.page("/spiceflow-dirs", async () => {
		const path = await import("node:path");
		const cwd = process.cwd();
		return (
			<div data-testid="spiceflow-dirs">
				<span data-testid="public-dir">{path.relative(cwd, publicDir) || "."}</span>
				<span data-testid="dist-dir">{path.relative(cwd, distDir) || "."}</span>
			</div>
		);
	})
	.page("/raw-import-test", async () => {
		return (
			<div data-testid="raw-import-content">
				<pre>{testContentRaw}</pre>
			</div>
		);
	})
	.page("/form-action-error-test", async () => {
		async function handleSubmit(prev: string, formData: FormData) {
			"use server";
			throw new Error("Action failed: invalid input");
		}
		return <ActionFormTest action={handleSubmit} />;
	})
	.page("/error-boundary-form-test", async () => {
		async function handleSubmit(formData: FormData) {
			"use server";
			const message = formData.get("message") as string;
			if (message === "fail") throw new Error("Validation failed: bad input");
			// success — no return needed
		}
		return <ErrorBoundaryFormTest action={handleSubmit} />;
	})
	.page("/error-boundary-inline-test", async () => {
		async function handleSubmit(formData: FormData) {
			"use server";
			const message = formData.get("message") as string;
			if (message === "fail") throw new Error("Inline boundary: action failed");
		}
		return <InlineErrorBoundaryFormTest action={handleSubmit} />;
	})
	.page("/error-boundary-long-message", async () => {
		async function handleSubmit(formData: FormData) {
			"use server";
			throw new Error(
				Array.from({ length: 30 }, (_, i) => `Line ${i + 1}: error detail here`).join("\n"),
			);
		}
		return <ErrorBoundaryFormTest action={handleSubmit} />;
	})
	.page("/parse-form-data-error-boundary", async () => {
		async function handleSubmit(formData: FormData) {
			"use server";
			// No try/catch: ValidationError from parseFormData propagates to ErrorBoundary
			parseFormData(ebFormSchema, formData);
		}
		return <ParseFormDataErrorBoundaryTest action={handleSubmit} fields={ebFormFields} />;
	})
	.page("/uncaught-action-test", async () => {
		async function failingAction() {
			"use server";
			throw new Error("Uncaught action error: something went wrong");
		}
		return <UncaughtActionTest action={failingAction} />;
	})
	.page("/parse-form-data-test", async () => {
		async function handleSubmit(prev: string, formData: FormData) {
			"use server";
			try {
				const data = parseFormData(contactSchema, formData);
				return `name=${data.name}, age=${data.age}, tags=${data.tags.join("+")}`;
			} catch (e: any) {
				return `error:${e.message}`;
			}
		}
		return <ParseFormDataTest action={handleSubmit} fields={contactFields} />;
	})
	// --- .get() redirect followed by router.push() test ---
	.get("/get-redirect/:id", ({ params, request }) => {
		const base = new URL(request.url);
		return new Response(null, {
			status: 302,
			headers: {
				Location: new URL(`/get-redirect/${params.id}/target`, base).toString(),
			},
		});
	})
	.page("/get-redirect/:id/target", async ({ params }) => {
		return (
			<div data-testid="get-redirect-target">
				Redirect target for {params.id}
			</div>
		);
	})
	.page("/get-redirect-nav", async () => {
		return <GetRedirectNav />;
	})
	// --- Loader tests ---
	.loader("/loader-test/*", async () => {
		return { global: "from-wildcard-loader" };
	})
	.loader("/loader-test/nested", async () => {
		return { nested: "from-nested-loader" };
	})
	.page("/loader-test", async ({ loaderData }) => {
		return (
			<div>
				<div data-testid="loader-data-server">{JSON.stringify(loaderData)}</div>
				<LoaderDataDisplay />
				<SubscribeDataReader />
				<LoaderNavLinks />
			</div>
		);
	})
	.page("/loader-test/nested", async ({ loaderData }) => {
		return (
			<div>
				<div data-testid="loader-data-server">{JSON.stringify(loaderData)}</div>
				<LoaderDataDisplay />
				<SubscribeDataReader />
				<LoaderNavLinks />
			</div>
		);
	})
	.page("/loader-test/other", async ({ loaderData }) => {
		return (
			<div>
				<div data-testid="loader-data-server">{JSON.stringify(loaderData)}</div>
				<LoaderDataDisplay />
				<SubscribeDataReader />
				<LoaderNavLinks />
			</div>
		);
	})
	.page("/loader-nav-start", async () => {
		return (
			<div>
				<LoaderNavLinks />
			</div>
		);
	})
	// --- router.getLoaderData imperative tests ---
	.page("/loader-test/global", async ({ loaderData }) => {
		return (
			<div>
				<div data-testid="loader-data-server">{JSON.stringify(loaderData)}</div>
				<GlobalLoaderDisplay />
				<SubscribeDataReader />
			</div>
		);
	})
	// --- Loader redirect/notFound tests ---
	.loader("/loader-redirect", async () => {
		throw redirect("/other");
	})
	.page("/loader-redirect", async () => {
		return <div>should not render</div>;
	})
	.loader("/loader-redirect-return", async () => {
		return redirect("/other");
	})
	.page("/loader-redirect-return", async () => {
		return <div>should not render</div>;
	})
	.loader("/loader-notfound", async () => {
		throw notFound();
	})
	.page("/loader-notfound", async () => {
		return <div>should not render</div>;
	})
	.loader("/loader-notfound-return", async () => {
		return notFound();
	})
	.page("/loader-notfound-return", async () => {
		return <div>should not render</div>;
	})
	.loader("/loader-error", async () => {
		throw new Error("loader-boom");
	})
	.page("/loader-error", async () => {
		return <div>should not render</div>;
	});

app.page("/absolute-url-test", async () => {
	return <AbsoluteUrlTest />;
});

const somePaths = ["/static/one", "/static/two"];
for (const path of somePaths) {
	app.staticPage(path);
}

if (process.env.STATIC_PAGE_ERROR) {
	app.staticPage("/static-error", async () => {
		return <StaticPageThrows />;
	});
}

async function StaticPageThrows() {
	throw new Error("static page build error");
}

app.staticGet("/api/staticfile.json", () => ({
	name: "integration-tests",
	version: "1.0.0",
	features: ["rsc", "streaming", "static-get"],
}));

async function Redirects() {
	await sleep(10);
	throw redirect("/");
	return <div>Redirect</div>;
}

async function ServerComponentThrows() {
	throw new Error("Server component error");
	return <div>Server component</div>;
}

// Server component that accidentally uses useState (a client-only API).
// useState is undefined in the react-server build, so calling it throws a TypeError.
// The formatServerError utility should rewrite this into an actionable message.
function UseStateInServerComponent() {
	const [count] = useState(0);
	return <div>count: {count}</div>;
}

void app
	.get("/api/takumi-image", () => {
		return new ImageResponse(
			<div
				style={{
					width: "100%",
					height: "100%",
					display: "flex",
					backgroundColor: "#0f172a",
					padding: 8,
					gap: 8,
				}}
			>
				<div style={{ flex: 1, borderRadius: 18, backgroundColor: "#14b8a6" }} />
				<div style={{ flex: 1, borderRadius: 18, backgroundColor: "#f8fafc" }} />
			</div>,
			{
				width: 120,
				height: 60,
				format: "png",
			},
		);
	})
	.get("/api/sharp-test", async () => {
		const sharp = (await import("sharp")).default;
		const metadata = await sharp({
			create: {
				width: 10,
				height: 10,
				channels: 3,
				background: { r: 255, g: 0, b: 0 },
			},
		})
			.png()
			.metadata();
		return { format: metadata.format, width: metadata.width };
	})
	.get("/api/lodash-test", async () => {
		const _ = (await import("lodash")).default;
		return { result: _.chunk([1, 2, 3, 4, 5, 6], 2) };
	})
	.page({
		path: "/page-query-test",
		query: z.object({ q: z.string(), page: z.coerce.number() }),
		handler: async ({ query }) => {
			return (
				<div data-testid="page-query-test">
					q={String(query.q ?? "none")} page={String(query.page ?? "none")}
				</div>
			);
		},
	})
	.listen(Number(process.env.PORT || 3000));

declare module "spiceflow/react" {
	interface SpiceflowRegister {
		app: typeof app;
	}
}
