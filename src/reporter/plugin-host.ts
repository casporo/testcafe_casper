import chalk, { Chalk } from 'chalk';
import indentString from 'indent-string';
import callsite from 'callsite';

import {
    identity,
    escape as escapeHtml,
    assignIn,
} from 'lodash';

import moment from '../utils/moment-loader';
import { wordWrap, removeTTYColors } from '../utils/string';
import getViewportWidth from '../utils/get-viewport-width';
import { DIFF_COLORS } from '../utils/diff/colors';
import { Moment } from 'moment';
import ReporterStreamController from '../runner/reporter-stream-controller';
import { Writable } from 'stream';
import TestRunErrorFormattableAdapter from '../errors/test-run/formattable-adapter';
import REPORTER_SYMBOLS from '../reporter/symbols';
import { ReporterSymbols } from './interfaces';
import { ReporterPluginHooks, WriteInfo } from './index';
import ReporterPluginMethod from './plugin-methods';

// NOTE: we should not expose internal state to
// the plugin, to avoid accidental rewrites.
// Therefore we use symbols to store them.
const stream          = Symbol();
const wordWrapEnabled = Symbol();
const indent          = Symbol();
const errorDecorator  = Symbol();

export default class ReporterPluginHost {
    public name?: string;
    public streamController: ReporterStreamController | null;
    public chalk: Chalk;
    public moment: Moment;
    public viewportWidth: number;
    public symbols: ReporterSymbols;
    private [stream]: Writable;
    private [wordWrapEnabled]: boolean;
    private [indent]: number;
    private [errorDecorator]: Record<string, Function>;
    private _hooks: ReporterPluginHooks | undefined;

    public constructor (plugin: any, outStream?: Writable, name?: string, pluginHooks?: ReporterPluginHooks) {
        this.name             = name;
        this.streamController = null;
        this[stream]          = outStream || process.stdout;
        this[wordWrapEnabled] = false;
        this[indent]          = 0;

        const useColors = this[stream] === process.stdout && chalk.enabled && !plugin.noColors;

        this.chalk         = new chalk.constructor({ enabled: useColors });
        this.moment        = moment;
        this.viewportWidth = getViewportWidth(this[stream]);
        this.symbols       = Object.assign({}, REPORTER_SYMBOLS);

        assignIn(this, plugin);

        this._hooks = pluginHooks;

        this[errorDecorator] = this.createErrorDecorator();
    }

    // Error decorator
    public createErrorDecorator (): Record<string, Function> {
        return {
            'span user-agent': (str: string) => this.chalk.grey(str),

            'span subtitle': (str: string) => `- ${this.chalk.bold.red(str)} -`,
            'div message':   (str: string) => this.chalk.bold.red(str),

            'div screenshot-info': identity,
            'a screenshot-path':   (str: string) => this.chalk.grey.underline(str),

            'code': identity,

            'span syntax-string':     (str: string) => this.chalk.green(str),
            'span syntax-punctuator': (str: string) => this.chalk.grey(str),
            'span syntax-keyword':    (str: string) => this.chalk.cyan(str),
            'span syntax-number':     (str: string) => this.chalk.magenta(str),
            'span syntax-regex':      (str: string) => this.chalk.magenta(str),
            'span syntax-comment':    (str: string) => this.chalk.grey.bold(str),
            'span syntax-invalid':    (str: string) => this.chalk.inverse(str),

            [`span ${DIFF_COLORS.DIFF_NOT_MODIFIED}`]: (str: string) => this.chalk.gray(str),
            [`span ${DIFF_COLORS.DIFF_ADDED}`]:        (str: string) => this.chalk.green(str),
            [`span ${DIFF_COLORS.DIFF_REMOVED}`]:      (str: string) => this.chalk.red(str),

            'div code-frame':         identity,
            'div code-line':          (str: string) => str + '\n',
            'div code-line-last':     identity,
            'div code-line-num':      (str: string) => `   ${str} |`,
            'div code-line-num-base': (str: string) => this.chalk.bgRed(` > ${str} `) + '|',
            'div code-line-src':      identity,

            'div stack':               (str: string) => '\n\n' + str,
            'div stack-line':          (str: string) => str + '\n',
            'div stack-line-last':     identity,
            'div stack-line-name':     (str: string) => `   at ${this.chalk.bold(str)}`,
            'div stack-line-location': (str: string) => ` (${this.chalk.grey.underline(str)})`,

            'strong': (str: string) => this.chalk.bold(str),
            'a':      (str: string) => `"${this.chalk.underline(str)}"`,
        };
    }

    // String helpers
    public indentString (str: string, indentVal: number): string {
        return indentString(str, ' ', indentVal);
    }

    public wordWrap (str: string, indentVal: number, width: number): string {
        return wordWrap(str, indentVal, width);
    }

    public escapeHtml (str: string): string {
        return escapeHtml(str);
    }

    public formatError (err: TestRunErrorFormattableAdapter, prefix = ''): string {
        const prefixLengthWithoutColors = removeTTYColors(prefix).length;
        const maxMsgLength              = this.viewportWidth - this[indent] - prefixLengthWithoutColors;

        let msg = err.formatMessage(this[errorDecorator], maxMsgLength);

        if (this[wordWrapEnabled])
            msg = this.wordWrap(msg, prefixLengthWithoutColors, maxMsgLength);
        else
            msg = this.indentString(msg, prefixLengthWithoutColors);

        return prefix + msg.substr(prefixLengthWithoutColors);
    }


    // Writing helpers
    public newline (): ReporterPluginHost {
        this._writeToUniqueStream('\n');

        return this;
    }

    public write (text: string, data?: any): ReporterPluginHost {
        if (this[wordWrapEnabled])
            text = this.wordWrap(text, this[indent], this.viewportWidth);
        else
            text = this.indentString(text, this[indent]);

        if (this._hooks?.onBeforeWrite) {
            const writeInfo = this._createBeforeWriteInfo(text, data);

            this._hooks.onBeforeWrite(writeInfo);
            this._writeToUniqueStream(writeInfo.formattedText);
        }
        else
            this._writeToUniqueStream(text);

        return this;
    }

    public useWordWrap (use: boolean): ReporterPluginHost {
        this[wordWrapEnabled] = use;

        return this;
    }

    public setIndent (val: number): ReporterPluginHost {
        this[indent] = val;

        return this;
    }

    private _createBeforeWriteInfo (formattedText: string, data: any = {}): WriteInfo {
        const initiator = data.initiator || this._getWriteInitiatorEvent();

        return {
            formatOptions: {
                indent:      this[indent],
                useWordWrap: this[wordWrapEnabled],
            },
            formattedText,
            initiator,
            data,
        };
    }

    private _getWriteInitiatorEvent (): string {
        const pluginMethods = Object.keys(ReporterPluginMethod);
        const funcNames = callsite().map(site => site.getFunctionName());
        const initiator = funcNames.find(funcName => pluginMethods.some(methodName => methodName === funcName));

        return initiator || '';
    }

    private _writeToUniqueStream (text: string): void {
        if (!this.streamController || this.streamController.ensureUniqueStream(this[stream], this))
            this[stream].write(text);
    }


    // Abstract methods implemented in plugin
    public async reportTaskStart (/* startTime, userAgents, testCount, testStructure, taskProperties */): Promise<never> {
        throw new Error('Not implemented');
    }

    public async reportFixtureStart (/* name, path */): Promise<never> {
        throw new Error('Not implemented');
    }

    // NOTE: It's an optional method
    // async reportTestStart (/* name, testMeta */) {
    //     throw new Error('Not implemented');
    // }

    public async reportTestDone (/* name, testRunInfo */): Promise<never> {
        throw new Error('Not implemented');
    }

    public async reportTaskDone (/* endTime, passed, warnings */): Promise<never> {
        throw new Error('Not implemented');
    }

    // NOTE: It's an optional method
    public async init (): Promise<void> { // eslint-disable-line @typescript-eslint/no-empty-function
        // Optional
    }

    // NOTE: It's an optional method
    public async reportWarnings (/* warnings */): Promise<void> { // eslint-disable-line @typescript-eslint/no-empty-function
    }

    // NOTE: It's an optional method
    public async reportData (/* testRun, ...data */): Promise<void> { // eslint-disable-line @typescript-eslint/no-empty-function
    }
}
