import { yellow } from 'kleur/colors';
import { encodeHex, decodeHex, base64 } from 'oslo/encoding';
import type { APIContext, MiddlewareNext } from '../../@types/astro.js';
import { defineMiddleware } from '../../core/middleware/index.js';
import { ApiContextStorage } from './store.js';
import {
	formContentTypes,
	getAction,
	hasContentType,
	actionKey,
	encoder,
	decoder,
} from './utils.js';
import { callSafely, getActionQueryString } from './virtual/shared.js';

export type Locals = {
	_actionsInternal: {
		getActionResult: APIContext['getActionResult'];
		actionResult?: ReturnType<APIContext['getActionResult']>;
	};
};

export const onRequest = defineMiddleware(async (context, next) => {
	const locals = context.locals as Locals;
	// Actions middleware may have run already after a path rewrite.
	// See https://github.com/withastro/roadmap/blob/feat/reroute/proposals/0047-rerouting.md#ctxrewrite
	// `_actionsInternal` is the same for every page,
	// so short circuit if already defined.
	if (locals._actionsInternal) return ApiContextStorage.run(context, () => next());

	const actionName = context.url.searchParams.get('__action');
	const encodedActionResult = context.url.searchParams.get('__result');

	if (context.request.method === 'GET' && actionName && encodedActionResult) {
		const actionResult = encodedActionResult ? await decodeResult(encodedActionResult) : undefined;
		return handleResult({ context, next, actionName, actionResult });
	}

	if (context.request.method === 'POST' && actionName) {
		return handlePost({ context, next, actionName });
	}

	// TODO: handle GET form requests with actions
	if (context.request.method === 'GET' && actionName) {
		throw new Error(
			'Actions cannot be invoked with GET requests. Did you forget to set method="post" on your form?'
		);
	}

	if (context.request.method === 'POST') {
		return handlePostLegacy({ context, next });
	}

	return nextWithLocalsStub(next, context);
});

async function handlePost({
	context,
	next,
	actionName,
}: { context: APIContext; next: MiddlewareNext; actionName: string }) {
	const { request } = context;

	// Heuristic: If body is null, Astro might've reset this for prerendering.
	// Stub with warning when `getActionResult()` is used.
	if (request.body === null) {
		return nextWithStaticStub(next, context);
	}

	const action = await getAction(actionName);
	// TODO: AstroError
	if (!action) {
		throw new Error(`Action "${actionName}" not found.`);
	}

	const contentType = request.headers.get('content-type');
	let formData: FormData | undefined;
	if (contentType && hasContentType(contentType, formContentTypes)) {
		formData = await request.clone().formData();
	}
	const result = await ApiContextStorage.run(context, () => callSafely(() => action(formData)));

	const redirectUrl = new URL(context.url);
	redirectUrl.searchParams.set('__result', await encodeResult(result));
	console.log('$$$redirect', redirectUrl.href);
	return context.redirect(redirectUrl.href);
}

function handleResult({
	context,
	next,
	actionName,
	actionResult,
}: { context: APIContext; next: MiddlewareNext; actionName: string; actionResult: any }) {
	const actionsInternal: Locals['_actionsInternal'] = {
		getActionResult: (actionFn) => {
			if (actionFn.toString() !== getActionQueryString(actionName)) {
				return Promise.resolve(undefined);
			}
			return actionResult;
		},
		actionResult,
	};
	const locals = context.locals as Locals;
	Object.defineProperty(locals, '_actionsInternal', { writable: false, value: actionsInternal });

	return ApiContextStorage.run(context, async () => {
		const response = await next();
		if (actionResult.error) {
			return new Response(response.body, {
				status: actionResult.error.status,
				statusText: actionResult.error.type,
				headers: response.headers,
			});
		}
		return response;
	});
}

async function handlePostLegacy({ context, next }: { context: APIContext; next: MiddlewareNext }) {
	const { request } = context;

	// Heuristic: If body is null, Astro might've reset this for prerendering.
	// Stub with warning when `getActionResult()` is used.
	if (request.body === null) {
		return nextWithStaticStub(next, context);
	}

	const contentType = request.headers.get('content-type');
	let formData: FormData | undefined;
	if (contentType && hasContentType(contentType, formContentTypes)) {
		formData = await request.clone().formData();
	}

	if (!formData) return nextWithLocalsStub(next, context);

	const actionName = formData.get('__action') as string;
	if (!actionName) return nextWithLocalsStub(next, context);

	const action = await getAction(actionName);
	// TODO: AstroError
	if (!action) {
		throw new Error(`Action "${actionName}" not found.`);
	}

	const actionResult = await ApiContextStorage.run(context, () =>
		callSafely(() => action(formData))
	);
	return handleResult({ context, next, actionName, actionResult });
}

function nextWithStaticStub(next: MiddlewareNext, context: APIContext) {
	Object.defineProperty(context.locals, '_actionsInternal', {
		writable: false,
		value: {
			getActionResult: () => {
				console.warn(
					yellow('[astro:actions]'),
					'`getActionResult()` should not be called on prerendered pages. Astro can only handle actions for pages rendered on-demand.'
				);
				return undefined;
			},
		},
	});
	return ApiContextStorage.run(context, () => next());
}

function nextWithLocalsStub(next: MiddlewareNext, context: APIContext) {
	Object.defineProperty(context.locals, '_actionsInternal', {
		writable: false,
		value: {
			getActionResult: () => undefined,
		},
	});
	return ApiContextStorage.run(context, () => next());
}

async function encodeResult(result: any) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = encoder.encode(JSON.stringify(result));
	const encryptedBuffer = await crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv,
		},
		actionKey,
		data
	);
	const encryptedString = base64.encode(new Uint8Array(encryptedBuffer));
	return encodeHex(iv) + encryptedString;
}

async function decodeResult(encodedResult: string) {
	const iv = decodeHex(encodedResult.slice(0, 24));
	const dataArray = base64.decode(encodedResult.slice(24));
	const decryptedBuffer = await crypto.subtle.decrypt(
		{
			name: 'AES-GCM',
			iv,
		},
		actionKey,
		dataArray
	);
	const decryptedString = decoder.decode(decryptedBuffer);
	return JSON.parse(decryptedString);
}
