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
