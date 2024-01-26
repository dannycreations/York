import { ParseError, ParseOptions, parse } from 'jsonc-parser'

export function parseJson(text: string, errors?: ParseError[], options?: ParseOptions) {
	return parse(text, errors, options)
}
