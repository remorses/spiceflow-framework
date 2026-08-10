// Client component for testing uncaught server action errors.
// Calls actions from onClick without try/catch or ErrorBoundary.
// The framework should show a toast instead of crashing the page.

"use client";

import React from "react";

export function UncaughtActionTest({
	action,
}: {
	action: () => Promise<void>;
}) {
	return (
		<div data-testid="uncaught-action-test">
			<h2>Uncaught Action Test</h2>
			<p data-testid="page-content">This content should stay visible</p>
			<button
				data-testid="call-uncaught-action"
				onClick={() => {
					// Intentionally NOT catching the error.
					// The framework should show a toast instead of crashing.
					action();
				}}
			>
				Call Uncaught Action
			</button>
		</div>
	);
}

export function ThrowJsonActionTest({
	throwJson,
	throwJsonWithMessage,
	returnJson,
}: {
	throwJson: () => Promise<void>;
	throwJsonWithMessage: () => Promise<void>;
	returnJson: () => Promise<any>;
}) {
	const [error, setError] = React.useState<string | null>(null);
	const [result, setResult] = React.useState<string | null>(null);
	return (
		<div data-testid="throw-json-test">
			<p data-testid="page-content">Throw JSON test</p>
			{error && <p data-testid="caught-error">{error}</p>}
			{result && <p data-testid="return-result">{result}</p>}
			<button
				data-testid="throw-json-fields"
				onClick={async () => {
					try {
						await throwJson();
					} catch (e: any) {
						setError(e.message);
					}
				}}
			>
				Throw JSON fields
			</button>
			<button
				data-testid="throw-json-message"
				onClick={async () => {
					try {
						await throwJsonWithMessage();
					} catch (e: any) {
						setError(e.message);
					}
				}}
			>
				Throw JSON with message
			</button>
			<button
				data-testid="return-json"
				onClick={async () => {
					try {
						const data = await returnJson();
						setResult(JSON.stringify(data));
					} catch (e: any) {
						setError(e.message);
					}
				}}
			>
				Return JSON
			</button>
		</div>
	);
}
