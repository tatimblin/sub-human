import { assert, Cache, CacheConfig, SchemaWithCache, cache, SchemaWithCacheAsync, cacheAsync, config, Fallback, SchemaWithFallback, fallback, FallbackAsync, SchemaWithFallbackAsync, fallbackAsync, FlatErrors, flatten, KeyOf$1, Path$1, RequiredPath$1, LazyPath$1, ValidPath$1, forward, forwardAsync, SchemaWithDefault, SchemaWithDefaultAsync, InferDefault, getDefault, InferDefaults, getDefaults, getDefaultsAsync, Schema$14, getDescription, Schema$13, RecursiveConcat, InferExamples, getExamples, InferFallback, getFallback, InferFallbacks, getFallbacks, getFallbacksAsync, SchemaWithPipe, pipe, SchemaWithPipeAsync, pipeAsync, Schema$12, BasicPipeItem, RecursiveMerge$1, InferMetadata, getMetadata, TitleAction, title, Schema$11, getTitle, is, Schema$10, ForceTuple, ObjectKeys$1, keyof, message, Schema$9, SchemaWithOmit, omit, parse, parseAsync, Parser, parser, ParserAsync, parserAsync, Schema$8, PartialEntries$1, SchemaWithPartial, partial, Schema$7, PartialEntries, SchemaWithPartialAsync, partialAsync, Schema$6 } from './1.d.mts';
import { SchemaWithPick, pick, Schema$5, RequiredEntries$1, SchemaWithRequired, required, Schema$4, RequiredEntries, SchemaWithRequiredAsync, requiredAsync, SafeParseResult, safeParse, safeParseAsync, SafeParser, safeParser, SafeParserAsync, safeParserAsync, summarize, unwrap, BaseMetadata, GenericMetadata, UnknownDataset, SuccessDataset, PartialDataset, FailureDataset, OutputDataset, StandardProps, StandardResult, StandardSuccessResult, StandardFailureResult, StandardIssue, StandardPathItem, StandardTypes, BaseSchema, BaseSchemaAsync, GenericSchema, GenericSchemaAsync, BaseTransformation, BaseTransformationAsync, GenericTransformation, GenericTransformationAsync, BaseValidation, BaseValidationAsync, GenericValidation, GenericValidationAsync, InferInput, InferOutput, InferIssue, IsAny, IsNever, NonNullable$1, NonNullish, NonOptional, MaybeReadonly, DeepReadonly, MaybeDeepReadonly, MaybePromise, Prettify, MarkOptional, Merge, FirstTupleItem, LastTupleItem, UnionToIntersect, UnionToTupleHelper, UnionToTuple, ErrorMessage, Default, DefaultAsync, DefaultValue, OptionalEntrySchema, OptionalEntrySchemaAsync, ObjectEntries, ObjectEntriesAsync, ObjectKeys, InferEntriesInput, InferEntriesOutput, OptionalInputKeys, OptionalOutputKeys, InputWithQuestionMarks, OutputWithQuestionMarks, ReadonlyOutputKeys, OutputWithReadonly, InferObjectInput, InferObjectOutput, InferObjectIssue, TupleItems, TupleItemsAsync, InferTupleInput, InferTupleOutput, InferTupleIssue, ArrayPathItem, MapPathItem, ObjectPathItem, SetPathItem, UnknownPathItem, IssuePathItem, BaseIssue, GenericIssue, DotPath, ObjectPath, TupleKeys, TuplePath, IssueDotPath, Config, PipeAction, PipeActionAsync, PipeItem, PipeItemAsync, SchemaWithoutPipe, GenericPipeAction, GenericPipeActionAsync, GenericPipeItem, GenericPipeItemAsync, AnySchema, any, ArrayIssue, ArraySchema, array, ArraySchemaAsync, arrayAsync, BigintIssue, BigintSchema, bigint, BlobIssue, BlobSchema, blob, BooleanIssue, BooleanSchema, boolean, CustomIssue, Check, CustomSchema, custom, CheckAsync, CustomSchemaAsync, customAsync, DateIssue, DateSchema, date, Enum, EnumValues, EnumIssue, EnumSchema, enum_, ExactOptionalSchema, exactOptional, ExactOptionalSchemaAsync, exactOptionalAsync, FileIssue, FileSchema, file, FunctionIssue, FunctionSchema, function_, Class, InstanceIssue, InstanceSchema, instance, IntersectIssue, IntersectOptions, IntersectOptionsAsync, InferOption, InferIntersectInput, InferIntersectOutput, IntersectSchema, intersect, IntersectSchemaAsync, intersectAsync, LazySchema, lazy, LazySchemaAsync, lazyAsync, Literal, LiteralIssue, LiteralSchema, literal, LooseObjectIssue, LooseObjectSchema, looseObject, LooseObjectSchemaAsync, looseObjectAsync, LooseTupleIssue, LooseTupleSchema, looseTuple, LooseTupleSchemaAsync, looseTupleAsync, MapIssue, InferMapInput, InferMapOutput, MapSchema, map, MapSchemaAsync, mapAsync, NanIssue, NanSchema, nan, NeverIssue, NeverSchema, never, UnionIssue, UnionOptions, UnionSchema, union, UnionOptionsAsync, UnionSchemaAsync, unionAsync, NonNullableIssue, InferNonNullableInput, InferNonNullableOutput, InferNonNullableIssue, NonNullableSchema, nonNullable, NonNullableSchemaAsync, nonNullableAsync, NonNullishIssue, InferNonNullishInput, InferNonNullishOutput, InferNonNullishIssue, NonNullishSchema, nonNullish, NonNullishSchemaAsync, nonNullishAsync, NonOptionalIssue, InferNonOptionalInput, InferNonOptionalOutput, InferNonOptionalIssue, NonOptionalSchema, nonOptional, NonOptionalSchemaAsync, nonOptionalAsync, NullIssue, NullSchema, null_, InferNullableOutput, NullableSchema, nullable, NullableSchemaAsync, nullableAsync, InferNullishOutput, NullishSchema, nullish, NullishSchemaAsync, nullishAsync, NumberIssue, NumberSchema, number, ObjectIssue, ObjectSchema, object, ObjectSchemaAsync, objectAsync, ObjectWithRestIssue, ObjectWithRestSchema, objectWithRest, ObjectWithRestSchemaAsync, objectWithRestAsync, InferOptionalOutput, OptionalSchema, optional, OptionalSchemaAsync, optionalAsync, PicklistOptions, PicklistIssue, PicklistSchema, picklist, PromiseIssue, PromiseSchema, promise, RecordIssue, IsLiteral, OptionalKeys, WithQuestionMarks, WithReadonly, InferRecordInput, InferRecordOutput, RecordSchema, record, RecordSchemaAsync, recordAsync, SetIssue, InferSetInput, InferSetOutput, SetSchema, set, SetSchemaAsync, setAsync, StrictObjectIssue, StrictObjectSchema, strictObject, StrictObjectSchemaAsync, strictObjectAsync, StrictTupleIssue, StrictTupleSchema, strictTuple, StrictTupleSchemaAsync, strictTupleAsync, StringIssue, StringSchema, string, SymbolIssue, SymbolSchema, symbol, TupleIssue, TupleSchema, tuple, TupleSchemaAsync, tupleAsync, TupleWithRestIssue, TupleWithRestSchema, tupleWithRest, TupleWithRestSchemaAsync, tupleWithRestAsync, UndefinedIssue, UndefinedSchema, undefined_, InferUndefinedableOutput, UndefinedableSchema, undefinedable, UndefinedableSchemaAsync, undefinedableAsync, UnknownSchema, unknown, VariantSchema, variant, VariantSchemaAsync, variantAsync, VariantIssue, VariantOptionSchema, VariantOptionSchemaAsync, VariantObjectEntries, VariantObjectEntriesAsync, VariantOption, VariantOptionAsync, VariantOptions, VariantOptionsAsync, InferVariantIssue, VoidIssue, VoidSchema, void_, Schema$3, ArgsAction, args, Schema$2, ArgsActionAsync, argsAsync, AwaitActionAsync, awaitAsync, Base64Issue, Base64Action, base64, BicIssue, BicAction, bic, BrandSymbol, BrandName, Brand, BrandAction, brand, BytesIssue, BytesAction, bytes, CheckIssue, CheckAction, check, CheckActionAsync, checkAsync, ArrayInput, ArrayRequirement, ArrayRequirementAsync, ContentInput, ContentRequirement, EntriesInput, LengthInput, SizeInput, ValueInput, CheckItemsIssue, CheckItemsAction, checkItems, CheckItemsActionAsync } from './2.d.mts';
import { uuid, ValueIssue, ValueAction, value, ValuesIssue, ValuesAction, values, WordsIssue, WordsAction, words, BASE64_REGEX, BIC_REGEX, CUID2_REGEX, DECIMAL_REGEX, DIGITS_REGEX, DOMAIN_REGEX, EMAIL_REGEX, EMOJI_REGEX, HEXADECIMAL_REGEX, HEX_COLOR_REGEX, IMEI_REGEX, IPV4_REGEX, IPV6_REGEX, IP_REGEX, ISO_DATE_REGEX, ISO_DATE_TIME_REGEX, ISO_DATE_TIME_SECOND_REGEX, ISO_TIME_REGEX, ISO_TIME_SECOND_REGEX, ISO_TIMESTAMP_REGEX, ISO_WEEK_REGEX, JWS_COMPACT_REGEX, ISRC_REGEX, KSUID_REGEX, MAC48_REGEX, MAC64_REGEX, MAC_REGEX, NANO_ID_REGEX, OCTAL_REGEX, RFC_EMAIL_REGEX, SLUG_REGEX, ULID_REGEX, UUID_REGEX, GlobalConfig, setGlobalConfig, getGlobalConfig, deleteGlobalConfig, setGlobalMessage, getGlobalMessage, deleteGlobalMessage, setSchemaMessage, getSchemaMessage, deleteSchemaMessage, Reference, setSpecificMessage, getSpecificMessage, deleteSpecificMessage, Context, Other, _addIssue, _cloneDataset, _formatCase, _getByteCount, _getCodePointCount, _getGraphemeCount, MetadataAction$1, Schema$1, _getLastMetadata, _getWordCount, _isLuhnAlgo, _isSameValueZero, _isValidObjectKey, _isValueMatch, _joinExpects, _standardSchema, _stringify, entriesFromList, Schema, RecursiveMerge, MergedEntries, entriesFromObjects, getDotPath, isOfKind, isOfType, ValiError, isValiError } from './4.d.mts';
/**
* Creates a check items validation action.
*
* @param requirement The validation function.
*
* @returns A check items action.
*/
declare function checkItemsAsync<TInput$1 extends ArrayInput>(requirement: ArrayRequirementAsync<TInput$1>): CheckItemsActionAsync<TInput$1, undefined>;
/**
* Creates a check items validation action.
*
* @param requirement The validation function.
* @param message The error message.
*
* @returns A check items action.
*/
declare function checkItemsAsync<TInput$1 extends ArrayInput, const TMessage extends ErrorMessage<CheckItemsIssue<TInput$1>> | undefined>(requirement: ArrayRequirementAsync<TInput$1>, message: TMessage): CheckItemsActionAsync<TInput$1, TMessage>;
//#endregion
//#region src/actions/codePoints/codePoints.d.ts
/**
* Code points issue interface.
*/
interface CodePointsIssue<TInput$1 extends string, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "code_points";
  /**
  * The expected property.
  */
  readonly expected: `${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The required code points.
  */
  readonly requirement: TRequirement;
}
/**
* Code points action interface.
*/
interface CodePointsAction<TInput$1 extends string, TRequirement extends number, TMessage extends ErrorMessage<CodePointsIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, CodePointsIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "code_points";
  /**
  * The action reference.
  */
  readonly reference: typeof codePoints;
  /**
  * The expected property.
  */
  readonly expects: `${TRequirement}`;
  /**
  * The required code points.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a code points validation action.
*
* @param requirement The required code points.
*
* @returns A code points action.
*/
declare function codePoints<TInput$1 extends string, const TRequirement extends number>(requirement: TRequirement): CodePointsAction<TInput$1, TRequirement, undefined>;
/**
* Creates a code points validation action.
*
* @param requirement The required code points.
* @param message The error message.
*
* @returns A code points action.
*/
declare function codePoints<TInput$1 extends string, const TRequirement extends number, const TMessage extends ErrorMessage<CodePointsIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): CodePointsAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/creditCard/creditCard.d.ts
/**
* Credit card issue interface.
*/
interface CreditCardIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "credit_card";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The validation function.
  */
  readonly requirement: (input: string) => boolean;
}
/**
* Credit card action interface.
*/
interface CreditCardAction<TInput$1 extends string, TMessage extends ErrorMessage<CreditCardIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, CreditCardIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "credit_card";
  /**
  * The action reference.
  */
  readonly reference: typeof creditCard;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The validation function.
  */
  readonly requirement: (input: string) => boolean;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [credit card](https://en.wikipedia.org/wiki/Payment_card_number) validation action.
*
* @returns A Credit card action.
*/
declare function creditCard<TInput$1 extends string>(): CreditCardAction<TInput$1, undefined>;
/**
* Creates a [credit card](https://en.wikipedia.org/wiki/Payment_card_number) validation action.
*
* @param message The error message.
*
* @returns A credit card action.
*/
declare function creditCard<TInput$1 extends string, const TMessage extends ErrorMessage<CreditCardIssue<TInput$1>> | undefined>(message: TMessage): CreditCardAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/cuid2/cuid2.d.ts
/**
* Cuid2 issue interface.
*/
interface Cuid2Issue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "cuid2";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The Cuid2 regex.
  */
  readonly requirement: RegExp;
}
/**
* Cuid2 action interface.
*/
interface Cuid2Action<TInput$1 extends string, TMessage extends ErrorMessage<Cuid2Issue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, Cuid2Issue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "cuid2";
  /**
  * The action reference.
  */
  readonly reference: typeof cuid2;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The Cuid2 regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [Cuid2](https://github.com/paralleldrive/cuid2) validation action.
*
* @returns A Cuid2 action.
*/
declare function cuid2<TInput$1 extends string>(): Cuid2Action<TInput$1, undefined>;
/**
* Creates a [Cuid2](https://github.com/paralleldrive/cuid2) validation action.
*
* @param message The error message.
*
* @returns A Cuid2 action.
*/
declare function cuid2<TInput$1 extends string, const TMessage extends ErrorMessage<Cuid2Issue<TInput$1>> | undefined>(message: TMessage): Cuid2Action<TInput$1, TMessage>;
//#endregion
//#region src/actions/decimal/decimal.d.ts
/**
* Decimal issue interface.
*/
interface DecimalIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "decimal";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The decimal regex.
  */
  readonly requirement: RegExp;
}
/**
* Decimal action interface.
*/
interface DecimalAction<TInput$1 extends string, TMessage extends ErrorMessage<DecimalIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, DecimalIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "decimal";
  /**
  * The action reference.
  */
  readonly reference: typeof decimal;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The decimal regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [decimal](https://en.wikipedia.org/wiki/Decimal) validation action.
*
* The difference between `decimal` and `digits` is that `decimal` accepts
* floating point numbers and negative numbers, while `digits` accepts only the
* digits 0-9.
*
* @returns An decimal action.
*/
declare function decimal<TInput$1 extends string>(): DecimalAction<TInput$1, undefined>;
/**
* Creates a [decimal](https://en.wikipedia.org/wiki/Decimal) validation action.
*
* The difference between `decimal` and `digits` is that `decimal` accepts
* floating point numbers and negative numbers, while `digits` accepts only the
* digits 0-9.
*
* @param message The error message.
*
* @returns An decimal action.
*/
declare function decimal<TInput$1 extends string, const TMessage extends ErrorMessage<DecimalIssue<TInput$1>> | undefined>(message: TMessage): DecimalAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/description/description.d.ts
/**
* Description action interface.
*/
interface DescriptionAction<TInput$1, TDescription extends string> extends BaseMetadata<TInput$1> {
  /**
  * The action type.
  */
  readonly type: "description";
  /**
  * The action reference.
  */
  readonly reference: typeof description;
  /**
  * The description text.
  */
  readonly description: TDescription;
}
/**
* Creates a description metadata action.
*
* @param description_ The description text.
*
* @returns A description action.
*/
declare function description<TInput$1, TDescription extends string>(description_: TDescription): DescriptionAction<TInput$1, TDescription>;
//#endregion
//#region src/actions/digits/digits.d.ts
/**
* Digits issue interface.
*/
interface DigitsIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "digits";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The digits regex.
  */
  readonly requirement: RegExp;
}
/**
* Digits action interface.
*/
interface DigitsAction<TInput$1 extends string, TMessage extends ErrorMessage<DigitsIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, DigitsIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "digits";
  /**
  * The action reference.
  */
  readonly reference: typeof digits;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The digits regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [digits](https://en.wikipedia.org/wiki/Numerical_digit) validation action.
*
* The difference between `digits` and `decimal` is that `digits` accepts only
* the digits 0-9, while `decimal` accepts floating point numbers and negative
* numbers.
*
* @returns An digits action.
*/
declare function digits<TInput$1 extends string>(): DigitsAction<TInput$1, undefined>;
/**
* Creates a [digits](https://en.wikipedia.org/wiki/Numerical_digit) validation action.
*
* The difference between `digits` and `decimal` is that `digits` accepts only
* the digits 0-9, while `decimal` accepts floating point numbers and negative
* numbers.
*
* @param message The error message.
*
* @returns An digits action.
*/
declare function digits<TInput$1 extends string, const TMessage extends ErrorMessage<DigitsIssue<TInput$1>> | undefined>(message: TMessage): DigitsAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/domain/domain.d.ts
/**
* Domain issue interface.
*
* @beta
*/
interface DomainIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "domain";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The domain regex.
  */
  readonly requirement: RegExp;
}
/**
* Domain action interface.
*
* @beta
*/
interface DomainAction<TInput$1 extends string, TMessage extends ErrorMessage<DomainIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, DomainIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "domain";
  /**
  * The action reference.
  */
  readonly reference: typeof domain;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The domain regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [domain name](https://en.wikipedia.org/wiki/Domain_name) validation
* action.
*
* Hint: ASCII-only validation. Internationalized domain names (IDNs) are not
* supported, including Punycode-encoded labels.
*
* @returns A domain action.
*
* @beta
*/
declare function domain<TInput$1 extends string>(): DomainAction<TInput$1, undefined>;
/**
* Creates a [domain name](https://en.wikipedia.org/wiki/Domain_name) validation
* action.
*
* Hint: ASCII-only validation. Internationalized domain names (IDNs) are not
* supported, including Punycode-encoded labels.
*
* @param message The error message.
*
* @returns A domain action.
*
* @beta
*/
declare function domain<TInput$1 extends string, const TMessage extends ErrorMessage<DomainIssue<TInput$1>> | undefined>(message: TMessage): DomainAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/email/email.d.ts
/**
* Email issue interface.
*/
interface EmailIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "email";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The email regex.
  */
  readonly requirement: RegExp;
}
/**
* Email action interface.
*/
interface EmailAction<TInput$1 extends string, TMessage extends ErrorMessage<EmailIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, EmailIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "email";
  /**
  * The action reference.
  */
  readonly reference: typeof email;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The email regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [email](https://en.wikipedia.org/wiki/Email_address) validation
* action.
*
* Hint: This validation action intentionally only validates common email
* addresses. If you are interested in an action that covers a broader
* subset of RFC 5322 addresses, please use the `rfcEmail` action instead.
*
* @returns An email action.
*/
declare function email<TInput$1 extends string>(): EmailAction<TInput$1, undefined>;
/**
* Creates an [email](https://en.wikipedia.org/wiki/Email_address) validation
* action.
*
* Hint: This validation action intentionally only validates common email
* addresses. If you are interested in an action that covers a broader
* subset of RFC 5322 addresses, please use the `rfcEmail` action instead.
*
* @param message The error message.
*
* @returns An email action.
*/
declare function email<TInput$1 extends string, const TMessage extends ErrorMessage<EmailIssue<TInput$1>> | undefined>(message: TMessage): EmailAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/emoji/emoji.d.ts
/**
* Emoji issue interface.
*/
interface EmojiIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "emoji";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The emoji regex.
  */
  readonly requirement: RegExp;
}
/**
* Emoji action interface.
*/
interface EmojiAction<TInput$1 extends string, TMessage extends ErrorMessage<EmojiIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, EmojiIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "emoji";
  /**
  * The action reference.
  */
  readonly reference: typeof emoji;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The emoji regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [emoji](https://en.wikipedia.org/wiki/Emoji) validation action.
*
* @returns An emoji action.
*/
declare function emoji<TInput$1 extends string>(): EmojiAction<TInput$1, undefined>;
/**
* Creates an [emoji](https://en.wikipedia.org/wiki/Emoji) validation action.
*
* @param message The error message.
*
* @returns An emoji action.
*/
declare function emoji<TInput$1 extends string, const TMessage extends ErrorMessage<EmojiIssue<TInput$1>> | undefined>(message: TMessage): EmojiAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/empty/empty.d.ts
/**
* Empty issue interface.
*/
interface EmptyIssue<TInput$1 extends LengthInput> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "empty";
  /**
  * The expected input.
  */
  readonly expected: "0";
  /**
  * The received input.
  */
  readonly received: `${number}`;
}
/**
* Empty action interface.
*/
interface EmptyAction<TInput$1 extends LengthInput, TMessage extends ErrorMessage<EmptyIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, EmptyIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "empty";
  /**
  * The action reference.
  */
  readonly reference: typeof empty;
  /**
  * The expected property.
  */
  readonly expects: "0";
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an empty validation action.
*
* @returns An empty action.
*/
declare function empty<TInput$1 extends LengthInput>(): EmptyAction<TInput$1, undefined>;
/**
* Creates an empty validation action.
*
* @param message The error message.
*
* @returns An empty action.
*/
declare function empty<TInput$1 extends LengthInput, const TMessage extends ErrorMessage<EmptyIssue<TInput$1>> | undefined>(message: TMessage): EmptyAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/endsWith/endsWith.d.ts
/**
* Ends with issue interface.
*/
interface EndsWithIssue<TInput$1 extends string, TRequirement extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "ends_with";
  /**
  * The expected property.
  */
  readonly expected: `"${TRequirement}"`;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The end string.
  */
  readonly requirement: TRequirement;
}
/**
* Ends with action interface.
*/
interface EndsWithAction<TInput$1 extends string, TRequirement extends string, TMessage extends ErrorMessage<EndsWithIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, EndsWithIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "ends_with";
  /**
  * The action reference.
  */
  readonly reference: typeof endsWith;
  /**
  * The expected property.
  */
  readonly expects: `"${TRequirement}"`;
  /**
  * The end string.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an ends with validation action.
*
* @param requirement The end string.
*
* @returns An ends with action.
*/
declare function endsWith<TInput$1 extends string, const TRequirement extends string>(requirement: TRequirement): EndsWithAction<TInput$1, TRequirement, undefined>;
/**
* Creates an ends with validation action.
*
* @param requirement The end string.
* @param message The error message.
*
* @returns An ends with action.
*/
declare function endsWith<TInput$1 extends string, const TRequirement extends string, const TMessage extends ErrorMessage<EndsWithIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): EndsWithAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/entries/entries.d.ts
/**
* Entries issue interface.
*
* @beta
*/
interface EntriesIssue<TInput$1 extends EntriesInput, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "entries";
  /**
  * The expected property.
  */
  readonly expected: `${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The required entries.
  */
  readonly requirement: TRequirement;
}
/**
* Entries action interface.
*
* @beta
*/
interface EntriesAction<TInput$1 extends EntriesInput, TRequirement extends number, TMessage extends ErrorMessage<EntriesIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, EntriesIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "entries";
  /**
  * The action reference.
  */
  readonly reference: typeof entries;
  /**
  * The expected property.
  */
  readonly expects: `${TRequirement}`;
  /**
  * The required entries.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an entries validation action.
*
* @param requirement The required entries.
*
* @returns An entries action.
*
* @beta
*/
declare function entries<TInput$1 extends EntriesInput, const TRequirement extends number>(requirement: TRequirement): EntriesAction<TInput$1, TRequirement, undefined>;
/**
* Creates an entries validation action.
*
* @param requirement The required entries.
* @param message The error message.
*
* @returns An entries action.
*
* @beta
*/
declare function entries<TInput$1 extends EntriesInput, const TRequirement extends number, const TMessage extends ErrorMessage<EntriesIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): EntriesAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/everyItem/everyItem.d.ts
/**
* Every item issue interface.
*/
interface EveryItemIssue<TInput$1 extends ArrayInput> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "every_item";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The validation function.
  */
  readonly requirement: ArrayRequirement<TInput$1>;
}
/**
* Every item action interface.
*/
interface EveryItemAction<TInput$1 extends ArrayInput, TMessage extends ErrorMessage<EveryItemIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, EveryItemIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "every_item";
  /**
  * The action reference.
  */
  readonly reference: typeof everyItem;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The validation function.
  */
  readonly requirement: ArrayRequirement<TInput$1>;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an every item validation action.
*
* @param requirement The validation function.
*
* @returns An every item action.
*/
declare function everyItem<TInput$1 extends ArrayInput>(requirement: ArrayRequirement<TInput$1>): EveryItemAction<TInput$1, undefined>;
/**
* Creates an every item validation action.
*
* @param requirement The validation function.
* @param message The error message.
*
* @returns An every item action.
*/
declare function everyItem<TInput$1 extends ArrayInput, const TMessage extends ErrorMessage<EveryItemIssue<TInput$1>> | undefined>(requirement: ArrayRequirement<TInput$1>, message: TMessage): EveryItemAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/examples/examples.d.ts
/**
* Examples action interface.
*/
interface ExamplesAction<TInput$1, TExamples extends readonly TInput$1[]> extends BaseMetadata<TInput$1> {
  /**
  * The action type.
  */
  readonly type: "examples";
  /**
  * The action reference.
  */
  readonly reference: typeof examples;
  /**
  * The examples.
  */
  readonly examples: TExamples;
}
/**
* Creates an examples metadata action.
*
* @param examples_ The examples.
*
* @returns An examples action.
*
* @beta
*/
declare function examples<TInput$1, const TExamples extends readonly TInput$1[]>(examples_: TExamples): ExamplesAction<TInput$1, TExamples>;
//#endregion
//#region src/actions/excludes/excludes.d.ts
/**
* Excludes issue interface.
*/
interface ExcludesIssue<TInput$1 extends ContentInput, TRequirement extends ContentRequirement<TInput$1>> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "excludes";
  /**
  * The expected property.
  */
  readonly expected: string;
  /**
  * The content to be excluded.
  */
  readonly requirement: TRequirement;
}
/**
* Excludes action interface.
*/
interface ExcludesAction<TInput$1 extends ContentInput, TRequirement extends ContentRequirement<TInput$1>, TMessage extends ErrorMessage<ExcludesIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, ExcludesIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "excludes";
  /**
  * The action reference.
  */
  readonly reference: typeof excludes;
  /**
  * The expected property.
  */
  readonly expects: string;
  /**
  * The content to be excluded.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an excludes validation action.
*
* @param requirement The content to be excluded.
*
* @returns An excludes action.
*/
declare function excludes<TInput$1 extends ContentInput, const TRequirement extends ContentRequirement<TInput$1>>(requirement: TRequirement): ExcludesAction<TInput$1, TRequirement, undefined>;
/**
* Creates an excludes validation action.
*
* @param requirement The content to be excluded.
* @param message The error message.
*
* @returns An excludes action.
*/
declare function excludes<TInput$1 extends ContentInput, const TRequirement extends ContentRequirement<TInput$1>, const TMessage extends ErrorMessage<ExcludesIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): ExcludesAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/filterItems/filterItems.d.ts
/**
* Filter items action interface.
*/
interface FilterItemsAction<TInput$1 extends ArrayInput> extends BaseTransformation<TInput$1, TInput$1, never> {
  /**
  * The action type.
  */
  readonly type: "filter_items";
  /**
  * The action reference.
  */
  readonly reference: typeof filterItems;
  /**
  * The filter items operation.
  */
  readonly operation: ArrayRequirement<TInput$1>;
}
/**
* Creates a filter items transformation action.
*
* @param operation The filter items operation.
*
* @returns A filter items action.
*/
declare function filterItems<TInput$1 extends ArrayInput>(operation: ArrayRequirement<TInput$1>): FilterItemsAction<TInput$1>;
//#endregion
//#region src/actions/findItem/findItem.d.ts
/**
* Array requirement type.
*/
type ArrayRequirement$1<TInput$1 extends ArrayInput, TOuput extends TInput$1[number]> = ((item: TInput$1[number], index: number, array: TInput$1) => item is TOuput) | ((item: TInput$1[number], index: number, array: TInput$1) => boolean);
/**
* Find item action interface.
*/
interface FindItemAction<TInput$1 extends ArrayInput, TOuput extends TInput$1[number]> extends BaseTransformation<TInput$1, TOuput | undefined, never> {
  /**
  * The action type.
  */
  readonly type: "find_item";
  /**
  * The action reference.
  */
  readonly reference: typeof findItem;
  /**
  * The find item operation.
  */
  readonly operation: ArrayRequirement$1<TInput$1, TOuput>;
}
/**
* Creates a find item transformation action.
*
* @param operation The find item operation.
*
* @returns A find item action.
*/
declare function findItem<TInput$1 extends ArrayInput, TOuput extends TInput$1[number]>(operation: ArrayRequirement$1<TInput$1, TOuput>): FindItemAction<TInput$1, TOuput>;
//#endregion
//#region src/actions/finite/finite.d.ts
/**
* Finite issue interface.
*/
interface FiniteIssue<TInput$1 extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "finite";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The validation function.
  */
  readonly requirement: (input: number) => boolean;
}
/**
* Finite action interface.
*/
interface FiniteAction<TInput$1 extends number, TMessage extends ErrorMessage<FiniteIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, FiniteIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "finite";
  /**
  * The action reference.
  */
  readonly reference: typeof finite;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The validation function.
  */
  readonly requirement: (input: number) => boolean;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [finite](https://en.wikipedia.org/wiki/Finite) validation action.
*
* @returns A finite action.
*/
declare function finite<TInput$1 extends number>(): FiniteAction<TInput$1, undefined>;
/**
* Creates a [finite](https://en.wikipedia.org/wiki/Finite) validation action.
*
* @param message The error message.
*
* @returns A finite action.
*/
declare function finite<TInput$1 extends number, const TMessage extends ErrorMessage<FiniteIssue<TInput$1>> | undefined>(message: TMessage): FiniteAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/flavor/flavor.d.ts
/**
* Flavor symbol.
*
* @beta
*/
declare const FlavorSymbol: unique symbol;
/**
* Flavor name type.
*
* @beta
*/
type FlavorName = string | number | symbol;
/**
* Flavor interface.
*
* @beta
*/
interface Flavor<TName extends FlavorName> {
  [FlavorSymbol]?: { [TValue in TName]: TValue };
}
/**
* Flavor action interface.
*
* @beta
*/
interface FlavorAction<TInput$1, TName extends FlavorName> extends BaseTransformation<TInput$1, TInput$1 & Flavor<TName>, never> {
  /**
  * The action type.
  */
  readonly type: "flavor";
  /**
  * The action reference.
  */
  readonly reference: typeof flavor;
  /**
  * The flavor name.
  */
  readonly name: TName;
}
/**
* Creates a flavor transformation action.
*
* @param name The flavor name.
*
* @returns A flavor action.
*
* @beta
*/
declare function flavor<TInput$1, TName extends FlavorName>(name: TName): FlavorAction<TInput$1, TName>;
//#endregion
//#region src/actions/graphemes/graphemes.d.ts
/**
* Graphemes issue interface.
*/
interface GraphemesIssue<TInput$1 extends string, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "graphemes";
  /**
  * The expected property.
  */
  readonly expected: `${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The required graphemes.
  */
  readonly requirement: TRequirement;
}
/**
* Graphemes action interface.
*/
interface GraphemesAction<TInput$1 extends string, TRequirement extends number, TMessage extends ErrorMessage<GraphemesIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, GraphemesIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "graphemes";
  /**
  * The action reference.
  */
  readonly reference: typeof graphemes;
  /**
  * The expected property.
  */
  readonly expects: `${TRequirement}`;
  /**
  * The required graphemes.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a graphemes validation action.
*
* @param requirement The required graphemes.
*
* @returns A graphemes action.
*/
declare function graphemes<TInput$1 extends string, const TRequirement extends number>(requirement: TRequirement): GraphemesAction<TInput$1, TRequirement, undefined>;
/**
* Creates a graphemes validation action.
*
* @param requirement The required graphemes.
* @param message The error message.
*
* @returns A graphemes action.
*/
declare function graphemes<TInput$1 extends string, const TRequirement extends number, const TMessage extends ErrorMessage<GraphemesIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): GraphemesAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/gtValue/gtValue.d.ts
/**
* Greater than value issue type.
*/
interface GtValueIssue<TInput$1 extends ValueInput, TRequirement extends TInput$1> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "gt_value";
  /**
  * The expected property.
  */
  readonly expected: `>${string}`;
  /**
  * The greater than value.
  */
  readonly requirement: TRequirement;
}
/**
* Greater than value action type.
*/
interface GtValueAction<TInput$1 extends ValueInput, TRequirement extends TInput$1, TMessage extends ErrorMessage<GtValueIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, GtValueIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "gt_value";
  /**
  * The action reference.
  */
  readonly reference: typeof gtValue;
  /**
  * The expected property.
  */
  readonly expects: `>${string}`;
  /**
  * The greater than value.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a greater than value validation action.
*
* @param requirement The greater than value.
*
* @returns A greater than value action.
*/
declare function gtValue<TInput$1 extends ValueInput, const TRequirement extends TInput$1>(requirement: TRequirement): GtValueAction<TInput$1, TRequirement, undefined>;
/**
* Creates a greater than value validation action.
*
* @param requirement The greater than value.
* @param message The error message.
*
* @returns A greater than value action.
*/
declare function gtValue<TInput$1 extends ValueInput, const TRequirement extends TInput$1, const TMessage extends ErrorMessage<GtValueIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): GtValueAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/guard/guard.d.ts
/**
* Guard function type.
*
* @beta
*/
type GuardFunction<TInput$1> = (input: TInput$1) => input is any;
/**
* Infer guard output type.
*
* @beta
*/
type InferGuardOutput<TGuard extends GuardFunction<any>> = TGuard extends ((input: any) => input is infer TOutput) ? TOutput : unknown;
/**
* Guard issue interface.
*
* @beta
*/
interface GuardIssue<TInput$1, TGuard extends GuardFunction<TInput$1>> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "transformation";
  /**
  * The issue type.
  */
  readonly type: "guard";
  /**
  * The guard function.
  */
  readonly requirement: TGuard;
}
/**
* Guard action interface.
*
* @beta
*/
interface GuardAction<TInput$1, TGuard extends GuardFunction<TInput$1>, TMessage extends ErrorMessage<GuardIssue<TInput$1, TGuard>> | undefined> extends BaseTransformation<TInput$1, TInput$1 & InferGuardOutput<TGuard>, GuardIssue<TInput$1, TGuard>> {
  /**
  * The action type.
  */
  readonly type: "guard";
  /**
  * The action reference.
  */
  readonly reference: typeof guard;
  /**
  * The guard function.
  */
  readonly requirement: TGuard;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a guard transformation action.
*
* @param requirement The guard function.
*
* @returns A guard action.
*
* @beta
*/
declare function guard<TInput$1, const TGuard extends GuardFunction<TInput$1>>(requirement: TGuard): GuardAction<TInput$1, TGuard, undefined>;
/**
* Creates a guard transformation action.
*
* @param requirement The guard function.
*
* @returns A guard action.
*
* @beta
*/
declare function guard<const TGuard extends GuardFunction<any>>(requirement: TGuard): GuardAction<Parameters<TGuard>[0], TGuard, undefined>;
/**
* Creates a guard transformation action.
*
* @param requirement The guard function.
* @param message The error message.
*
* @returns A guard action.
*
* @beta
*/
declare function guard<TInput$1, const TGuard extends GuardFunction<TInput$1>, const TMessage extends ErrorMessage<GuardIssue<TInput$1, TGuard>> | undefined>(requirement: TGuard, message: TMessage): GuardAction<TInput$1, TGuard, TMessage>;
/**
* Creates a guard transformation action.
*
* @param requirement The guard function.
* @param message The error message.
*
* @returns A guard action.
*
* @beta
*/
declare function guard<const TGuard extends GuardFunction<any>, const TMessage extends ErrorMessage<GuardIssue<Parameters<TGuard>[0], TGuard>> | undefined>(requirement: TGuard, message: TMessage): GuardAction<Parameters<TGuard>[0], TGuard, TMessage>;
//#endregion
//#region src/actions/hash/hash.d.ts
/**
* Hash lengths object.
*/
declare const HASH_LENGTHS: {
  readonly md4: 32;
  readonly md5: 32;
  readonly sha1: 40;
  readonly sha256: 64;
  readonly sha384: 96;
  readonly sha512: 128;
  readonly ripemd128: 32;
  readonly ripemd160: 40;
  readonly tiger128: 32;
  readonly tiger160: 40;
  readonly tiger192: 48;
  readonly crc32: 8;
  readonly crc32b: 8;
  readonly adler32: 8;
};
/**
* Hash type type.
*/
type HashType = keyof typeof HASH_LENGTHS;
/**
* Hash issue interface.
*/
interface HashIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "hash";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The hash regex.
  */
  readonly requirement: RegExp;
}
/**
* Hash action interface.
*/
interface HashAction<TInput$1 extends string, TMessage extends ErrorMessage<HashIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, HashIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "hash";
  /**
  * The action reference.
  */
  readonly reference: typeof hash;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The hash regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [hash](https://en.wikipedia.org/wiki/Hash_function) validation action.
*
* @param types The hash types.
*
* @returns A hash action.
*/
declare function hash<TInput$1 extends string>(types: [HashType, ...HashType[]]): HashAction<TInput$1, undefined>;
/**
* Creates a [hash](https://en.wikipedia.org/wiki/Hash_function) validation action.
*
* @param types The hash types.
* @param message The error message.
*
* @returns A hash action.
*/
declare function hash<TInput$1 extends string, const TMessage extends ErrorMessage<HashIssue<TInput$1>> | undefined>(types: [HashType, ...HashType[]], message: TMessage): HashAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/hexadecimal/hexadecimal.d.ts
/**
* Hexadecimal issue interface.
*/
interface HexadecimalIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "hexadecimal";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The hexadecimal regex.
  */
  readonly requirement: RegExp;
}
/**
* Hexadecimal action interface.
*/
interface HexadecimalAction<TInput$1 extends string, TMessage extends ErrorMessage<HexadecimalIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, HexadecimalIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "hexadecimal";
  /**
  * The action reference.
  */
  readonly reference: typeof hexadecimal;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The hexadecimal regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [hexadecimal](https://en.wikipedia.org/wiki/Hexadecimal) validation action.
*
* @returns A hexadecimal action.
*/
declare function hexadecimal<TInput$1 extends string>(): HexadecimalAction<TInput$1, undefined>;
/**
* Creates a [hexadecimal](https://en.wikipedia.org/wiki/Hexadecimal) validation action.
*
* @param message The error message.
*
* @returns A hexadecimal action.
*/
declare function hexadecimal<TInput$1 extends string, const TMessage extends ErrorMessage<HexadecimalIssue<TInput$1>> | undefined>(message: TMessage): HexadecimalAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/hexColor/hexColor.d.ts
/**
* Hex color issue interface.
*/
interface HexColorIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "hex_color";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The hex color regex.
  */
  readonly requirement: RegExp;
}
/**
* Hex color action interface.
*/
interface HexColorAction<TInput$1 extends string, TMessage extends ErrorMessage<HexColorIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, HexColorIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "hex_color";
  /**
  * The action reference.
  */
  readonly reference: typeof hexColor;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The hex color regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [hex color](https://en.wikipedia.org/wiki/Web_colors#Hex_triplet) validation action.
*
* @returns A hex color action.
*/
declare function hexColor<TInput$1 extends string>(): HexColorAction<TInput$1, undefined>;
/**
* Creates a [hex color](https://en.wikipedia.org/wiki/Web_colors#Hex_triplet) validation action.
*
* @param message The error message.
*
* @returns A hex color action.
*/
declare function hexColor<TInput$1 extends string, const TMessage extends ErrorMessage<HexColorIssue<TInput$1>> | undefined>(message: TMessage): HexColorAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/imei/imei.d.ts
/**
* IMEI issue interface.
*/
interface ImeiIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "imei";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The validation function.
  */
  readonly requirement: (input: string) => boolean;
}
/**
* IMEI action interface.
*/
interface ImeiAction<TInput$1 extends string, TMessage extends ErrorMessage<ImeiIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, ImeiIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "imei";
  /**
  * The action reference.
  */
  readonly reference: typeof imei;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The validation function.
  */
  readonly requirement: (input: string) => boolean;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [IMEI](https://en.wikipedia.org/wiki/International_Mobile_Equipment_Identity) validation action.
*
* Formats:
* - AABBBBBBCCCCCCD
* - AA-BBBBBB-CCCCCC-D
*
* @returns An IMEI action.
*/
declare function imei<TInput$1 extends string>(): ImeiAction<TInput$1, undefined>;
/**
* Creates an [IMEI](https://en.wikipedia.org/wiki/International_Mobile_Equipment_Identity) validation action.
*
* Formats:
* - AABBBBBBCCCCCCD
* - AA-BBBBBB-CCCCCC-D
*
* @param message The error message.
*
* @returns An IMEI action.
*/
declare function imei<TInput$1 extends string, const TMessage extends ErrorMessage<ImeiIssue<TInput$1>> | undefined>(message: TMessage): ImeiAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/includes/includes.d.ts
/**
* Includes issue interface.
*/
interface IncludesIssue<TInput$1 extends ContentInput, TRequirement extends ContentRequirement<TInput$1>> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "includes";
  /**
  * The expected property.
  */
  readonly expected: string;
  /**
  * The content to be included.
  */
  readonly requirement: TRequirement;
}
/**
* Includes action interface.
*/
interface IncludesAction<TInput$1 extends ContentInput, TRequirement extends ContentRequirement<TInput$1>, TMessage extends ErrorMessage<IncludesIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, IncludesIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "includes";
  /**
  * The action reference.
  */
  readonly reference: typeof includes;
  /**
  * The expected property.
  */
  readonly expects: string;
  /**
  * The content to be included.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an includes validation action.
*
* @param requirement The content to be included.
*
* @returns An includes action.
*/
declare function includes<TInput$1 extends ContentInput, const TRequirement extends ContentRequirement<TInput$1>>(requirement: TRequirement): IncludesAction<TInput$1, TRequirement, undefined>;
/**
* Creates an includes validation action.
*
* @param requirement The content to be included.
* @param message The error message.
*
* @returns An includes action.
*/
declare function includes<TInput$1 extends ContentInput, const TRequirement extends ContentRequirement<TInput$1>, const TMessage extends ErrorMessage<IncludesIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): IncludesAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/integer/integer.d.ts
/**
* Integer issue interface.
*/
interface IntegerIssue<TInput$1 extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "integer";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The validation function.
  */
  readonly requirement: (input: number) => boolean;
}
/**
* Integer action interface.
*/
interface IntegerAction<TInput$1 extends number, TMessage extends ErrorMessage<IntegerIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, IntegerIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "integer";
  /**
  * The action reference.
  */
  readonly reference: typeof integer;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The validation function.
  */
  readonly requirement: (input: number) => boolean;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [integer](https://en.wikipedia.org/wiki/Integer) validation action.
*
* @returns An integer action.
*/
declare function integer<TInput$1 extends number>(): IntegerAction<TInput$1, undefined>;
/**
* Creates an [integer](https://en.wikipedia.org/wiki/Integer) validation action.
*
* @param message The error message.
*
* @returns An integer action.
*/
declare function integer<TInput$1 extends number, const TMessage extends ErrorMessage<IntegerIssue<TInput$1>> | undefined>(message: TMessage): IntegerAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/ip/ip.d.ts
/**
* IP issue interface.
*/
interface IpIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "ip";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The IP regex.
  */
  readonly requirement: RegExp;
}
/**
* IP action interface.
*/
interface IpAction<TInput$1 extends string, TMessage extends ErrorMessage<IpIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, IpIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "ip";
  /**
  * The action reference.
  */
  readonly reference: typeof ip;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The IP regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [IP address](https://en.wikipedia.org/wiki/IP_address) validation action.
*
* @returns An IP action.
*/
declare function ip<TInput$1 extends string>(): IpAction<TInput$1, undefined>;
/**
* Creates an [IP address](https://en.wikipedia.org/wiki/IP_address) validation action.
*
* @param message The error message.
*
* @returns An IP action.
*/
declare function ip<TInput$1 extends string, const TMessage extends ErrorMessage<IpIssue<TInput$1>> | undefined>(message: TMessage): IpAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/ipv4/ipv4.d.ts
/**
* IPv4 issue interface.
*/
interface Ipv4Issue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "ipv4";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The IPv4 regex.
  */
  readonly requirement: RegExp;
}
/**
* IPv4 action interface.
*/
interface Ipv4Action<TInput$1 extends string, TMessage extends ErrorMessage<Ipv4Issue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, Ipv4Issue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "ipv4";
  /**
  * The action reference.
  */
  readonly reference: typeof ipv4;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The IPv4 regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [IPv4](https://en.wikipedia.org/wiki/IPv4) address validation action.
*
* @returns An IPv4 action.
*/
declare function ipv4<TInput$1 extends string>(): Ipv4Action<TInput$1, undefined>;
/**
* Creates an [IPv4](https://en.wikipedia.org/wiki/IPv4) address validation action.
*
* @param message The error message.
*
* @returns An IPv4 action.
*/
declare function ipv4<TInput$1 extends string, const TMessage extends ErrorMessage<Ipv4Issue<TInput$1>> | undefined>(message: TMessage): Ipv4Action<TInput$1, TMessage>;
//#endregion
//#region src/actions/ipv6/ipv6.d.ts
/**
* IPv6 issue interface.
*/
interface Ipv6Issue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "ipv6";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The IPv6 regex.
  */
  readonly requirement: RegExp;
}
/**
* IPv6 action interface.
*/
interface Ipv6Action<TInput$1 extends string, TMessage extends ErrorMessage<Ipv6Issue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, Ipv6Issue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "ipv6";
  /**
  * The action reference.
  */
  readonly reference: typeof ipv6;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The IPv6 regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [IPv6](https://en.wikipedia.org/wiki/IPv6) address validation action.
*
* @returns An IPv6 action.
*/
declare function ipv6<TInput$1 extends string>(): Ipv6Action<TInput$1, undefined>;
/**
* Creates an [IPv6](https://en.wikipedia.org/wiki/IPv6) address validation action.
*
* @param message The error message.
*
* @returns An IPv6 action.
*/
declare function ipv6<TInput$1 extends string, const TMessage extends ErrorMessage<Ipv6Issue<TInput$1>> | undefined>(message: TMessage): Ipv6Action<TInput$1, TMessage>;
//#endregion
//#region src/actions/isbn/isbn.d.ts
/**
* ISBN issue interface.
*/
interface IsbnIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "isbn";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The validation function.
  */
  readonly requirement: (input: string) => boolean;
}
/**
* ISBN action interface.
*/
interface IsbnAction<TInput$1 extends string, TMessage extends ErrorMessage<IsbnIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, IsbnIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "isbn";
  /**
  * The action reference.
  */
  readonly reference: typeof isbn;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The validation function.
  */
  readonly requirement: (input: string) => boolean;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [ISBN](https://en.wikipedia.org/wiki/ISBN) action.
*
* @returns An ISBN action.
*
* @beta
*/
declare function isbn<TInput$1 extends string>(): IsbnAction<TInput$1, undefined>;
/**
* Creates an [ISBN](https://en.wikipedia.org/wiki/ISBN) action.
*
* @param message The error message.
*
* @returns An ISBN action.
*
* @beta
*/
declare function isbn<TInput$1 extends string, const TMessage extends ErrorMessage<IsbnIssue<TInput$1>> | undefined>(message: TMessage): IsbnAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/isrc/isrc.d.ts
/**
* ISRC issue interface.
*/
interface IsrcIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "isrc";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The ISRC regex.
  */
  readonly requirement: RegExp;
}
/**
* ISRC action interface.
*/
interface IsrcAction<TInput$1 extends string, TMessage extends ErrorMessage<IsrcIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, IsrcIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "isrc";
  /**
  * The action reference.
  */
  readonly reference: typeof isrc;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The ISRC regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [ISRC](https://en.wikipedia.org/wiki/International_Standard_Recording_Code) validation action.
*
* Formats:
* - CCXXXYYNNNNN
* - CC-XXX-YY-NNNNN
*
* @returns An ISRC action.
*
* @beta
*/
declare function isrc<TInput$1 extends string>(): IsrcAction<TInput$1, undefined>;
/**
* Creates an [ISRC](https://en.wikipedia.org/wiki/International_Standard_Recording_Code) validation action.
*
* @param message The error message.
*
* @returns An ISRC action.
*
* @beta
*/
declare function isrc<TInput$1 extends string, const TMessage extends ErrorMessage<IsrcIssue<TInput$1>> | undefined>(message: TMessage): IsrcAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/isoDate/isoDate.d.ts
/**
* ISO date issue interface.
*/
interface IsoDateIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "iso_date";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The ISO date regex.
  */
  readonly requirement: RegExp;
}
/**
* ISO date action interface.
*/
interface IsoDateAction<TInput$1 extends string, TMessage extends ErrorMessage<IsoDateIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, IsoDateIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "iso_date";
  /**
  * The action reference.
  */
  readonly reference: typeof isoDate;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The ISO date regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [ISO date](https://en.wikipedia.org/wiki/ISO_8601) validation action.
*
* Format: yyyy-mm-dd
*
* Hint: The regex used cannot validate the maximum number of days based on
* year and month. For example, "2023-06-31" is valid although June has only
* 30 days.
*
* @returns An ISO date action.
*/
declare function isoDate<TInput$1 extends string>(): IsoDateAction<TInput$1, undefined>;
/**
* Creates an [ISO date](https://en.wikipedia.org/wiki/ISO_8601) validation action.
*
* Format: yyyy-mm-dd
*
* Hint: The regex used cannot validate the maximum number of days based on
* year and month. For example, "2023-06-31" is valid although June has only
* 30 days.
*
* @param message The error message.
*
* @returns An ISO date action.
*/
declare function isoDate<TInput$1 extends string, const TMessage extends ErrorMessage<IsoDateIssue<TInput$1>> | undefined>(message: TMessage): IsoDateAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/isoDateTime/isoDateTime.d.ts
/**
* ISO date time issue interface.
*/
interface IsoDateTimeIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "iso_date_time";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The ISO date time regex.
  */
  readonly requirement: RegExp;
}
/**
* ISO date time action interface.
*/
interface IsoDateTimeAction<TInput$1 extends string, TMessage extends ErrorMessage<IsoDateTimeIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, IsoDateTimeIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "iso_date_time";
  /**
  * The action reference.
  */
  readonly reference: typeof isoDateTime;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The ISO date time regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [ISO date time](https://en.wikipedia.org/wiki/ISO_8601) validation action.
*
* Format: yyyy-mm-ddThh:mm
*
* Hint: The regex used cannot validate the maximum number of days based on
* year and month. For example, "2023-06-31T00:00" is valid although June has only
* 30 days.
*
* Hint: The regex also allows a space as a separator between the date and time
* parts instead of the "T" character.
*
* @returns An ISO date time action.
*/
declare function isoDateTime<TInput$1 extends string>(): IsoDateTimeAction<TInput$1, undefined>;
/**
* Creates an [ISO date time](https://en.wikipedia.org/wiki/ISO_8601) validation action.
*
* Format: yyyy-mm-ddThh:mm
*
* Hint: The regex used cannot validate the maximum number of days based on
* year and month. For example, "2023-06-31T00:00" is valid although June has only
* 30 days.
*
* Hint: The regex also allows a space as a separator between the date and time
* parts instead of the "T" character.
*
* @param message The error message.
*
* @returns An ISO date time action.
*/
declare function isoDateTime<TInput$1 extends string, const TMessage extends ErrorMessage<IsoDateTimeIssue<TInput$1>> | undefined>(message: TMessage): IsoDateTimeAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/isoDateTimeSecond/isoDateTimeSecond.d.ts
/**
* ISO date time second issue interface.
*/
interface IsoDateTimeSecondIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "iso_date_time_second";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The ISO date time with seconds regex.
  */
  readonly requirement: RegExp;
}
/**
* ISO date time second action interface.
*/
interface IsoDateTimeSecondAction<TInput$1 extends string, TMessage extends ErrorMessage<IsoDateTimeSecondIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, IsoDateTimeSecondIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "iso_date_time_second";
  /**
  * The action reference.
  */
  readonly reference: typeof isoDateTimeSecond;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The ISO date time with seconds regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [ISO date time second](https://en.wikipedia.org/wiki/ISO_8601) validation action.
*
* Format: yyyy-mm-ddThh:mm:ss
*
* Hint: The regex used cannot validate the maximum number of days based on
* year and month. For example, "2023-06-31T00:00:00" is valid although June has only
* 30 days.
*
* Hint: The regex also allows a space as a separator between the date and time
* parts instead of the "T" character.
*
* @returns An ISO date time second action.
*/
declare function isoDateTimeSecond<TInput$1 extends string>(): IsoDateTimeSecondAction<TInput$1, undefined>;
/**
* Creates an [ISO date time second](https://en.wikipedia.org/wiki/ISO_8601) validation action.
*
* Format: yyyy-mm-ddThh:mm:ss
*
* Hint: The regex used cannot validate the maximum number of days based on
* year and month. For example, "2023-06-31T00:00:00" is valid although June has only
* 30 days.
*
* Hint: The regex also allows a space as a separator between the date and time
* parts instead of the "T" character.
*
* @param message The error message.
*
* @returns An ISO date time second action.
*/
declare function isoDateTimeSecond<TInput$1 extends string, const TMessage extends ErrorMessage<IsoDateTimeSecondIssue<TInput$1>> | undefined>(message: TMessage): IsoDateTimeSecondAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/isoTime/isoTime.d.ts
/**
* ISO time issue interface.
*/
interface IsoTimeIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "iso_time";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The ISO time regex.
  */
  readonly requirement: RegExp;
}
/**
* ISO time action interface.
*/
interface IsoTimeAction<TInput$1 extends string, TMessage extends ErrorMessage<IsoTimeIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, IsoTimeIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "iso_time";
  /**
  * The action reference.
  */
  readonly reference: typeof isoTime;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The ISO time regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [ISO time](https://en.wikipedia.org/wiki/ISO_8601) validation action.
*
* Format: hh:mm
*
* @returns An ISO time action.
*/
declare function isoTime<TInput$1 extends string>(): IsoTimeAction<TInput$1, undefined>;
/**
* Creates an [ISO time](https://en.wikipedia.org/wiki/ISO_8601) validation action.
*
* Format: hh:mm
*
* @param message The error message.
*
* @returns An ISO time action.
*/
declare function isoTime<TInput$1 extends string, const TMessage extends ErrorMessage<IsoTimeIssue<TInput$1>> | undefined>(message: TMessage): IsoTimeAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/isoTimeSecond/isoTimeSecond.d.ts
/**
* ISO time second issue interface.
*/
interface IsoTimeSecondIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "iso_time_second";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The ISO time with seconds regex.
  */
  readonly requirement: RegExp;
}
/**
* ISO time second action interface.
*/
interface IsoTimeSecondAction<TInput$1 extends string, TMessage extends ErrorMessage<IsoTimeSecondIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, IsoTimeSecondIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "iso_time_second";
  /**
  * The action reference.
  */
  readonly reference: typeof isoTimeSecond;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The ISO time second regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [ISO time second](https://en.wikipedia.org/wiki/ISO_8601) validation action.
*
* Format: hh:mm:ss
*
* @returns An ISO time second action.
*/
declare function isoTimeSecond<TInput$1 extends string>(): IsoTimeSecondAction<TInput$1, undefined>;
/**
* Creates an [ISO time second](https://en.wikipedia.org/wiki/ISO_8601) validation action.
*
* Format: hh:mm:ss
*
* @param message The error message.
*
* @returns An ISO time second action.
*/
declare function isoTimeSecond<TInput$1 extends string, const TMessage extends ErrorMessage<IsoTimeSecondIssue<TInput$1>> | undefined>(message: TMessage): IsoTimeSecondAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/isoTimestamp/isoTimestamp.d.ts
/**
* ISO timestamp issue interface.
*/
interface IsoTimestampIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "iso_timestamp";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The ISO timestamp regex.
  */
  readonly requirement: RegExp;
}
/**
* ISO timestamp action interface.
*/
interface IsoTimestampAction<TInput$1 extends string, TMessage extends ErrorMessage<IsoTimestampIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, IsoTimestampIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "iso_timestamp";
  /**
  * The action reference.
  */
  readonly reference: typeof isoTimestamp;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The ISO timestamp regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [ISO timestamp](https://en.wikipedia.org/wiki/ISO_8601) validation
* action.
*
* Formats:
* - yyyy-mm-ddThh:mm:ss.sssZ
* - yyyy-mm-ddThh:mm:ss.sss±hh:mm
* - yyyy-mm-ddThh:mm:ss.sss±hhmm
*
* Hint: To support timestamps with lower or higher accuracy, the millisecond
* specification can be removed or contain up to 9 digits.
*
* Hint: The regex used cannot validate the maximum number of days based on
* year and month. For example, "2023-06-31T00:00:00.000Z" is valid although
* June has only 30 days.
*
* Hint: The regex also allows a space as a separator between the date and time
* parts instead of the "T" character.
*
* Hint: The regex also allows a space before the UTC offset (e.g., " +00:00")
* to support PostgreSQL's `timestamptz` output format.
*
* @returns An ISO timestamp action.
*/
declare function isoTimestamp<TInput$1 extends string>(): IsoTimestampAction<TInput$1, undefined>;
/**
* Creates an [ISO timestamp](https://en.wikipedia.org/wiki/ISO_8601) validation
* action.
*
* Formats:
* - yyyy-mm-ddThh:mm:ss.sssZ
* - yyyy-mm-ddThh:mm:ss.sss±hh:mm
* - yyyy-mm-ddThh:mm:ss.sss±hhmm
* - yyyy-mm-ddThh:mm:ss.sss±hh
*
* Hint: To support timestamps with lower or higher accuracy, the millisecond
* specification can be removed or contain up to 9 digits.
*
* Hint: The regex used cannot validate the maximum number of days based on
* year and month. For example, "2023-06-31T00:00:00.000Z" is valid although
* June has only 30 days.
*
* Hint: The regex also allows a space as a separator between the date and time
* parts instead of the "T" character.
*
* Hint: The regex also allows a space before the UTC offset (e.g., " +00:00")
* to support PostgreSQL's `timestamptz` output format.
*
* @param message The error message.
*
* @returns An ISO timestamp action.
*/
declare function isoTimestamp<TInput$1 extends string, const TMessage extends ErrorMessage<IsoTimestampIssue<TInput$1>> | undefined>(message: TMessage): IsoTimestampAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/isoWeek/isoWeek.d.ts
/**
* ISO week issue interface.
*/
interface IsoWeekIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "iso_week";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The ISO week regex.
  */
  readonly requirement: RegExp;
}
/**
* ISO week action interface.
*/
interface IsoWeekAction<TInput$1 extends string, TMessage extends ErrorMessage<IsoWeekIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, IsoWeekIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "iso_week";
  /**
  * The action reference.
  */
  readonly reference: typeof isoWeek;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The ISO week regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [ISO week](https://en.wikipedia.org/wiki/ISO_8601) validation action.
*
* Format: yyyy-Www
*
* Hint: The regex used cannot validate the maximum number of weeks based on
* the year. For example, "2021W53" is valid although 2021 has only 52 weeks.
*
* @returns An ISO week action.
*/
declare function isoWeek<TInput$1 extends string>(): IsoWeekAction<TInput$1, undefined>;
/**
* Creates an [ISO week](https://en.wikipedia.org/wiki/ISO_8601) validation action.
*
* Format: yyyy-Www
*
* Hint: The regex used cannot validate the maximum number of weeks based on
* the year. For example, "2021W53" is valid although 2021 has only 52 weeks.
*
* @param message The error message.
*
* @returns An ISO week action.
*/
declare function isoWeek<TInput$1 extends string, const TMessage extends ErrorMessage<IsoWeekIssue<TInput$1>> | undefined>(message: TMessage): IsoWeekAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/jwsCompact/jwsCompact.d.ts
/**
* JWS compact issue interface.
*
* @beta
*/
interface JwsCompactIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "jws_compact";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The JWS compact regex.
  */
  readonly requirement: RegExp;
}
/**
* JWS compact action interface.
*
* @beta
*/
interface JwsCompactAction<TInput$1 extends string, TMessage extends ErrorMessage<JwsCompactIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, JwsCompactIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "jws_compact";
  /**
  * The action reference.
  */
  readonly reference: typeof jwsCompact;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The JWS compact regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [JWS compact serialization](https://datatracker.ietf.org/doc/html/rfc7515#section-3.1)
* validation action.
*
* Hint: This validation action only checks the three-part compact string shape
* with unpadded Base64URL-like segments. It does not decode the segments,
* verify the signature, or validate claims.
*
* @returns A JWS compact action.
*
* @beta
*/
declare function jwsCompact<TInput$1 extends string>(): JwsCompactAction<TInput$1, undefined>;
/**
* Creates a [JWS compact serialization](https://datatracker.ietf.org/doc/html/rfc7515#section-3.1)
* validation action.
*
* Hint: This validation action only checks the three-part compact string shape
* with unpadded Base64URL-like segments. It does not decode the segments,
* verify the signature, or validate claims.
*
* @param message The error message.
*
* @returns A JWS compact action.
*
* @beta
*/
declare function jwsCompact<TInput$1 extends string, const TMessage extends ErrorMessage<JwsCompactIssue<TInput$1>> | undefined>(message: TMessage): JwsCompactAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/ksuid/ksuid.d.ts
/**
* KSUID issue interface.
*/
interface KsuidIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "ksuid";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The KSUID regex.
  */
  readonly requirement: RegExp;
}
/**
* KSUID action interface.
*/
interface KsuidAction<TInput$1 extends string, TMessage extends ErrorMessage<KsuidIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, KsuidIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "ksuid";
  /**
  * The action reference.
  */
  readonly reference: typeof ksuid;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The KSUID regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [KSUID](https://github.com/segmentio/ksuid) validation action.
*
* @returns A KSUID action.
*/
declare function ksuid<TInput$1 extends string>(): KsuidAction<TInput$1, undefined>;
/**
* Creates a [KSUID](https://github.com/segmentio/ksuid) validation action.
*
* @param message The error message.
*
* @returns A KSUID action.
*/
declare function ksuid<TInput$1 extends string, const TMessage extends ErrorMessage<KsuidIssue<TInput$1>> | undefined>(message: TMessage): KsuidAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/length/length.d.ts
/**
* Length issue interface.
*/
interface LengthIssue<TInput$1 extends LengthInput, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "length";
  /**
  * The expected property.
  */
  readonly expected: `${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The required length.
  */
  readonly requirement: TRequirement;
}
/**
* Length action interface.
*/
interface LengthAction<TInput$1 extends LengthInput, TRequirement extends number, TMessage extends ErrorMessage<LengthIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, LengthIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "length";
  /**
  * The action reference.
  */
  readonly reference: typeof length;
  /**
  * The expected property.
  */
  readonly expects: `${TRequirement}`;
  /**
  * The required length.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a length validation action.
*
* @param requirement The required length.
*
* @returns A length action.
*/
declare function length<TInput$1 extends LengthInput, const TRequirement extends number>(requirement: TRequirement): LengthAction<TInput$1, TRequirement, undefined>;
/**
* Creates a length validation action.
*
* @param requirement The required length.
* @param message The error message.
*
* @returns A length action.
*/
declare function length<TInput$1 extends LengthInput, const TRequirement extends number, const TMessage extends ErrorMessage<LengthIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): LengthAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/ltValue/ltValue.d.ts
/**
* Less than value issue type.
*/
interface LtValueIssue<TInput$1 extends ValueInput, TRequirement extends TInput$1> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "lt_value";
  /**
  * The expected property.
  */
  readonly expected: `<${string}`;
  /**
  * The less than value.
  */
  readonly requirement: TRequirement;
}
/**
* Less than value action type.
*/
interface LtValueAction<TInput$1 extends ValueInput, TRequirement extends TInput$1, TMessage extends ErrorMessage<LtValueIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, LtValueIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "lt_value";
  /**
  * The action reference.
  */
  readonly reference: typeof ltValue;
  /**
  * The expected property.
  */
  readonly expects: `<${string}`;
  /**
  * The less than value.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a less than value validation action.
*
* @param requirement The less than value.
*
* @returns A less than value action.
*/
declare function ltValue<TInput$1 extends ValueInput, const TRequirement extends TInput$1>(requirement: TRequirement): LtValueAction<TInput$1, TRequirement, undefined>;
/**
* Creates a less than value validation action.
*
* @param requirement The less than value.
* @param message The error message.
*
* @returns A less than value action.
*/
declare function ltValue<TInput$1 extends ValueInput, const TRequirement extends TInput$1, const TMessage extends ErrorMessage<LtValueIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): LtValueAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/mac/mac.d.ts
/**
* MAC issue interface.
*/
interface MacIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "mac";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The MAC regex.
  */
  readonly requirement: RegExp;
}
/**
* MAC action interface.
*/
interface MacAction<TInput$1 extends string, TMessage extends ErrorMessage<MacIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, MacIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "mac";
  /**
  * The action reference.
  */
  readonly reference: typeof mac;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The MAC regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [MAC address](https://en.wikipedia.org/wiki/MAC_address) validation action.
*
* @returns A MAC action.
*/
declare function mac<TInput$1 extends string>(): MacAction<TInput$1, undefined>;
/**
* Creates a [MAC address](https://en.wikipedia.org/wiki/MAC_address) validation action.
*
* @param message The error message.
*
* @returns A MAC action.
*/
declare function mac<TInput$1 extends string, const TMessage extends ErrorMessage<MacIssue<TInput$1>> | undefined>(message: TMessage): MacAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/mac48/mac48.d.ts
/**
* 48-bit MAC issue interface.
*/
interface Mac48Issue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "mac48";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The 48-bit MAC regex.
  */
  readonly requirement: RegExp;
}
/**
* 48-bit MAC action interface.
*/
interface Mac48Action<TInput$1 extends string, TMessage extends ErrorMessage<Mac48Issue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, Mac48Issue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "mac48";
  /**
  * The action reference.
  */
  readonly reference: typeof mac48;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The 48-bit MAC regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a 48-bit [MAC address](https://en.wikipedia.org/wiki/MAC_address) validation action.
*
* @returns A 48-bit MAC action.
*/
declare function mac48<TInput$1 extends string>(): Mac48Action<TInput$1, undefined>;
/**
* Creates a 48-bit [MAC address](https://en.wikipedia.org/wiki/MAC_address) validation action.
*
* @param message The error message.
*
* @returns A 48-bit MAC action.
*/
declare function mac48<TInput$1 extends string, const TMessage extends ErrorMessage<Mac48Issue<TInput$1>> | undefined>(message: TMessage): Mac48Action<TInput$1, TMessage>;
//#endregion
//#region src/actions/mac64/mac64.d.ts
/**
* 64-bit MAC issue interface.
*/
interface Mac64Issue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "mac64";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The 64-bit MAC regex.
  */
  readonly requirement: RegExp;
}
/**
* 64-bit MAC action interface.
*/
interface Mac64Action<TInput$1 extends string, TMessage extends ErrorMessage<Mac64Issue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, Mac64Issue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "mac64";
  /**
  * The action reference.
  */
  readonly reference: typeof mac64;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The 64-bit MAC regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a 64-bit [MAC address](https://en.wikipedia.org/wiki/MAC_address) validation action.
*
* @returns A 64-bit MAC action.
*/
declare function mac64<TInput$1 extends string>(): Mac64Action<TInput$1, undefined>;
/**
* Creates a 64-bit [MAC address](https://en.wikipedia.org/wiki/MAC_address) validation action.
*
* @param message The error message.
*
* @returns A 64-bit MAC action.
*/
declare function mac64<TInput$1 extends string, const TMessage extends ErrorMessage<Mac64Issue<TInput$1>> | undefined>(message: TMessage): Mac64Action<TInput$1, TMessage>;
//#endregion
//#region src/actions/mapItems/mapItems.d.ts
/**
* Array action type.
*/
type ArrayAction$2<TInput$1 extends ArrayInput, TOutput$1> = (item: TInput$1[number], index: number, array: TInput$1) => TOutput$1;
/**
* Map items action interface.
*/
interface MapItemsAction<TInput$1 extends ArrayInput, TOutput$1> extends BaseTransformation<TInput$1, TOutput$1[], never> {
  /**
  * The action type.
  */
  readonly type: "map_items";
  /**
  * The action reference.
  */
  readonly reference: typeof mapItems;
  /**
  * The map items operation.
  */
  readonly operation: ArrayAction$2<TInput$1, TOutput$1>;
}
/**
* Creates a map items transformation action.
*
* @param operation The map items operation.
*
* @returns A map items action.
*/
declare function mapItems<TInput$1 extends ArrayInput, TOutput$1>(operation: ArrayAction$2<TInput$1, TOutput$1>): MapItemsAction<TInput$1, TOutput$1>;
//#endregion
//#region src/actions/maxBytes/maxBytes.d.ts
/**
* Max bytes issue interface.
*/
interface MaxBytesIssue<TInput$1 extends string, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "max_bytes";
  /**
  * The expected property.
  */
  readonly expected: `<=${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The maximum bytes.
  */
  readonly requirement: TRequirement;
}
/**
* Max bytes action interface.
*/
interface MaxBytesAction<TInput$1 extends string, TRequirement extends number, TMessage extends ErrorMessage<MaxBytesIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, MaxBytesIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "max_bytes";
  /**
  * The action reference.
  */
  readonly reference: typeof maxBytes;
  /**
  * The expected property.
  */
  readonly expects: `<=${TRequirement}`;
  /**
  * The maximum bytes.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a max [bytes](https://en.wikipedia.org/wiki/Byte) validation action.
*
* @param requirement The maximum bytes.
*
* @returns A max bytes action.
*/
declare function maxBytes<TInput$1 extends string, const TRequirement extends number>(requirement: TRequirement): MaxBytesAction<TInput$1, TRequirement, undefined>;
/**
* Creates a max [bytes](https://en.wikipedia.org/wiki/Byte) validation action.
*
* @param requirement The maximum bytes.
* @param message The error message.
*
* @returns A max bytes action.
*/
declare function maxBytes<TInput$1 extends string, const TRequirement extends number, const TMessage extends ErrorMessage<MaxBytesIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): MaxBytesAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/maxCodePoints/maxCodePoints.d.ts
/**
* Max code points issue interface.
*/
interface MaxCodePointsIssue<TInput$1 extends string, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "max_code_points";
  /**
  * The expected property.
  */
  readonly expected: `<=${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The maximum code points.
  */
  readonly requirement: TRequirement;
}
/**
* Max code points action interface.
*/
interface MaxCodePointsAction<TInput$1 extends string, TRequirement extends number, TMessage extends ErrorMessage<MaxCodePointsIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, MaxCodePointsIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "max_code_points";
  /**
  * The action reference.
  */
  readonly reference: typeof maxCodePoints;
  /**
  * The expected property.
  */
  readonly expects: `<=${TRequirement}`;
  /**
  * The maximum code points.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a max code points validation action.
*
* @param requirement The maximum code points.
*
* @returns A max code points action.
*/
declare function maxCodePoints<TInput$1 extends string, const TRequirement extends number>(requirement: TRequirement): MaxCodePointsAction<TInput$1, TRequirement, undefined>;
/**
* Creates a max code points validation action.
*
* @param requirement The maximum code points.
* @param message The error message.
*
* @returns A max code points action.
*/
declare function maxCodePoints<TInput$1 extends string, const TRequirement extends number, const TMessage extends ErrorMessage<MaxCodePointsIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): MaxCodePointsAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/maxEntries/maxEntries.d.ts
/**
* Max entries issue interface.
*
* @beta
*/
interface MaxEntriesIssue<TInput$1 extends EntriesInput, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "max_entries";
  /**
  * The expected property.
  */
  readonly expected: `<=${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The maximum entries.
  */
  readonly requirement: TRequirement;
}
/**
* Max entries action interface.
*
* @beta
*/
interface MaxEntriesAction<TInput$1 extends EntriesInput, TRequirement extends number, TMessage extends ErrorMessage<MaxEntriesIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, MaxEntriesIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "max_entries";
  /**
  * The action reference.
  */
  readonly reference: typeof maxEntries;
  /**
  * The expected property.
  */
  readonly expects: `<=${TRequirement}`;
  /**
  * The maximum entries.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a max entries validation action.
*
* @param requirement The maximum entries.
*
* @returns A max entries action.
*
* @beta
*/
declare function maxEntries<TInput$1 extends EntriesInput, const TRequirement extends number>(requirement: TRequirement): MaxEntriesAction<TInput$1, TRequirement, undefined>;
/**
* Creates a max entries validation action.
*
* @param requirement The maximum entries.
* @param message The error message.
*
* @returns A max entries action.
*
* @beta
*/
declare function maxEntries<TInput$1 extends EntriesInput, const TRequirement extends number, const TMessage extends ErrorMessage<MaxEntriesIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): MaxEntriesAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/maxGraphemes/maxGraphemes.d.ts
/**
* Max graphemes issue interface.
*/
interface MaxGraphemesIssue<TInput$1 extends string, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "max_graphemes";
  /**
  * The expected property.
  */
  readonly expected: `<=${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The maximum graphemes.
  */
  readonly requirement: TRequirement;
}
/**
* Max graphemes action interface.
*/
interface MaxGraphemesAction<TInput$1 extends string, TRequirement extends number, TMessage extends ErrorMessage<MaxGraphemesIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, MaxGraphemesIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "max_graphemes";
  /**
  * The action reference.
  */
  readonly reference: typeof maxGraphemes;
  /**
  * The expected property.
  */
  readonly expects: `<=${TRequirement}`;
  /**
  * The maximum graphemes.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a max graphemes validation action.
*
* @param requirement The maximum graphemes.
*
* @returns A max graphemes action.
*/
declare function maxGraphemes<TInput$1 extends string, const TRequirement extends number>(requirement: TRequirement): MaxGraphemesAction<TInput$1, TRequirement, undefined>;
/**
* Creates a max graphemes validation action.
*
* @param requirement The maximum graphemes.
* @param message The error message.
*
* @returns A max graphemes action.
*/
declare function maxGraphemes<TInput$1 extends string, const TRequirement extends number, const TMessage extends ErrorMessage<MaxGraphemesIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): MaxGraphemesAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/maxLength/maxLength.d.ts
/**
* Max length issue interface.
*/
interface MaxLengthIssue<TInput$1 extends LengthInput, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "max_length";
  /**
  * The expected property.
  */
  readonly expected: `<=${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The maximum length.
  */
  readonly requirement: TRequirement;
}
/**
* Max length action interface.
*/
interface MaxLengthAction<TInput$1 extends LengthInput, TRequirement extends number, TMessage extends ErrorMessage<MaxLengthIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, MaxLengthIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "max_length";
  /**
  * The action reference.
  */
  readonly reference: typeof maxLength;
  /**
  * The expected property.
  */
  readonly expects: `<=${TRequirement}`;
  /**
  * The maximum length.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a max length validation action.
*
* @param requirement The maximum length.
*
* @returns A max length action.
*/
declare function maxLength<TInput$1 extends LengthInput, const TRequirement extends number>(requirement: TRequirement): MaxLengthAction<TInput$1, TRequirement, undefined>;
/**
* Creates a max length validation action.
*
* @param requirement The maximum length.
* @param message The error message.
*
* @returns A max length action.
*/
declare function maxLength<TInput$1 extends LengthInput, const TRequirement extends number, const TMessage extends ErrorMessage<MaxLengthIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): MaxLengthAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/maxSize/maxSize.d.ts
/**
* Max size issue interface.
*/
interface MaxSizeIssue<TInput$1 extends SizeInput, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "max_size";
  /**
  * The expected property.
  */
  readonly expected: `<=${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The maximum size.
  */
  readonly requirement: TRequirement;
}
/**
* Max size action interface.
*/
interface MaxSizeAction<TInput$1 extends SizeInput, TRequirement extends number, TMessage extends ErrorMessage<MaxSizeIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, MaxSizeIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "max_size";
  /**
  * The action reference.
  */
  readonly reference: typeof maxSize;
  /**
  * The expected property.
  */
  readonly expects: `<=${TRequirement}`;
  /**
  * The maximum size.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a max size validation action.
*
* @param requirement The maximum size.
*
* @returns A max size action.
*/
declare function maxSize<TInput$1 extends SizeInput, const TRequirement extends number>(requirement: TRequirement): MaxSizeAction<TInput$1, TRequirement, undefined>;
/**
* Creates a max size validation action.
*
* @param requirement The maximum size.
* @param message The error message.
*
* @returns A max size action.
*/
declare function maxSize<TInput$1 extends SizeInput, const TRequirement extends number, const TMessage extends ErrorMessage<MaxSizeIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): MaxSizeAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/maxValue/maxValue.d.ts
/**
* Max value issue interface.
*/
interface MaxValueIssue<TInput$1 extends ValueInput, TRequirement extends ValueInput> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "max_value";
  /**
  * The expected property.
  */
  readonly expected: `<=${string}`;
  /**
  * The maximum value.
  */
  readonly requirement: TRequirement;
}
/**
* Max value action interface.
*/
interface MaxValueAction<TInput$1 extends ValueInput, TRequirement extends TInput$1, TMessage extends ErrorMessage<MaxValueIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, MaxValueIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "max_value";
  /**
  * The action reference.
  */
  readonly reference: typeof maxValue;
  /**
  * The expected property.
  */
  readonly expects: `<=${string}`;
  /**
  * The maximum value.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a max value validation action.
*
* @param requirement The maximum value.
*
* @returns A max value action.
*/
declare function maxValue<TInput$1 extends ValueInput, const TRequirement extends TInput$1>(requirement: TRequirement): MaxValueAction<TInput$1, TRequirement, undefined>;
/**
* Creates a max value validation action.
*
* @param requirement The maximum value.
* @param message The error message.
*
* @returns A max value action.
*/
declare function maxValue<TInput$1 extends ValueInput, const TRequirement extends TInput$1, const TMessage extends ErrorMessage<MaxValueIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): MaxValueAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/maxWords/maxWords.d.ts
/**
* Max words issue interface.
*/
interface MaxWordsIssue<TInput$1 extends string, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "max_words";
  /**
  * The expected property.
  */
  readonly expected: `<=${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The maximum words.
  */
  readonly requirement: TRequirement;
}
/**
* Max words action interface.
*/
interface MaxWordsAction<TInput$1 extends string, TLocales extends Intl.LocalesArgument, TRequirement extends number, TMessage extends ErrorMessage<MaxWordsIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, MaxWordsIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "max_words";
  /**
  * The action reference.
  */
  readonly reference: typeof maxWords;
  /**
  * The expected property.
  */
  readonly expects: `<=${TRequirement}`;
  /**
  * The locales to be used.
  */
  readonly locales: TLocales;
  /**
  * The maximum words.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a max words validation action.
*
* @param locales The locales to be used.
* @param requirement The maximum words.
*
* @returns A max words action.
*/
declare function maxWords<TInput$1 extends string, TLocales extends Intl.LocalesArgument, const TRequirement extends number>(locales: TLocales, requirement: TRequirement): MaxWordsAction<TInput$1, TLocales, TRequirement, undefined>;
/**
* Creates a max words validation action.
*
* @param locales The locales to be used.
* @param requirement The maximum words.
* @param message The error message.
*
* @returns A max words action.
*/
declare function maxWords<TInput$1 extends string, TLocales extends Intl.LocalesArgument, const TRequirement extends number, const TMessage extends ErrorMessage<MaxWordsIssue<TInput$1, TRequirement>> | undefined>(locales: TLocales, requirement: TRequirement, message: TMessage): MaxWordsAction<TInput$1, TLocales, TRequirement, TMessage>;
//#endregion
//#region src/actions/metadata/metadata.d.ts
/**
* Metadata action interface.
*/
interface MetadataAction<TInput$1, TMetadata extends Record<string, unknown>> extends BaseMetadata<TInput$1> {
  /**
  * The action type.
  */
  readonly type: "metadata";
  /**
  * The action reference.
  */
  readonly reference: typeof metadata;
  /**
  * The metadata object.
  */
  readonly metadata: TMetadata;
}
/**
* Creates a custom metadata action.
*
* @param metadata_ The metadata object.
*
* @returns A metadata action.
*/
declare function metadata<TInput$1, const TMetadata extends Record<string, unknown>>(metadata_: TMetadata): MetadataAction<TInput$1, TMetadata>;
//#endregion
//#region src/actions/mimeType/mimeType.d.ts
/**
* Requirement type.
*/
type Requirement = readonly `${string}/${string}`[];
/**
* MIME type issue interface.
*/
interface MimeTypeIssue<TInput$1 extends Blob, TRequirement extends Requirement> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "mime_type";
  /**
  * The expected input.
  */
  readonly expected: string;
  /**
  * The received input.
  */
  readonly received: `"${string}"`;
  /**
  * The MIME types.
  */
  readonly requirement: TRequirement;
}
/**
* MIME type action interface.
*/
interface MimeTypeAction<TInput$1 extends Blob, TRequirement extends Requirement, TMessage extends ErrorMessage<MimeTypeIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, MimeTypeIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "mime_type";
  /**
  * The action reference.
  */
  readonly reference: typeof mimeType;
  /**
  * The expected property.
  */
  readonly expects: string;
  /**
  * The MIME types.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [MIME type](https://developer.mozilla.org/docs/Web/HTTP/Basics_of_HTTP/MIME_types) validation action.
*
* @param requirement The MIME types.
*
* @returns A MIME type action.
*/
declare function mimeType<TInput$1 extends Blob, const TRequirement extends Requirement>(requirement: TRequirement): MimeTypeAction<TInput$1, TRequirement, undefined>;
/**
* Creates a [MIME type](https://developer.mozilla.org/docs/Web/HTTP/Basics_of_HTTP/MIME_types) validation action.
*
* @param requirement The MIME types.
* @param message The error message.
*
* @returns A MIME type action.
*/
declare function mimeType<TInput$1 extends Blob, const TRequirement extends Requirement, const TMessage extends ErrorMessage<MimeTypeIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): MimeTypeAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/minBytes/minBytes.d.ts
/**
* Min bytes issue interface.
*/
interface MinBytesIssue<TInput$1 extends string, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "min_bytes";
  /**
  * The expected property.
  */
  readonly expected: `>=${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The minimum bytes.
  */
  readonly requirement: TRequirement;
}
/**
* Min bytes action interface.
*/
interface MinBytesAction<TInput$1 extends string, TRequirement extends number, TMessage extends ErrorMessage<MinBytesIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, MinBytesIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "min_bytes";
  /**
  * The action reference.
  */
  readonly reference: typeof minBytes;
  /**
  * The expected property.
  */
  readonly expects: `>=${TRequirement}`;
  /**
  * The minimum bytes.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a min [bytes](https://en.wikipedia.org/wiki/Byte) validation action.
*
* @param requirement The minimum bytes.
*
* @returns A min bytes action.
*/
declare function minBytes<TInput$1 extends string, const TRequirement extends number>(requirement: TRequirement): MinBytesAction<TInput$1, TRequirement, undefined>;
/**
* Creates a min [bytes](https://en.wikipedia.org/wiki/Byte) validation action.
*
* @param requirement The minimum bytes.
* @param message The error message.
*
* @returns A min bytes action.
*/
declare function minBytes<TInput$1 extends string, const TRequirement extends number, const TMessage extends ErrorMessage<MinBytesIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): MinBytesAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/minCodePoints/minCodePoints.d.ts
/**
* Min code points issue interface.
*/
interface MinCodePointsIssue<TInput$1 extends string, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "min_code_points";
  /**
  * The expected property.
  */
  readonly expected: `>=${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The minimum code points.
  */
  readonly requirement: TRequirement;
}
/**
* Min code points action interface.
*/
interface MinCodePointsAction<TInput$1 extends string, TRequirement extends number, TMessage extends ErrorMessage<MinCodePointsIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, MinCodePointsIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "min_code_points";
  /**
  * The action reference.
  */
  readonly reference: typeof minCodePoints;
  /**
  * The expected property.
  */
  readonly expects: `>=${TRequirement}`;
  /**
  * The minimum code points.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a min code points validation action.
*
* @param requirement The minimum code points.
*
* @returns A min code points action.
*/
declare function minCodePoints<TInput$1 extends string, const TRequirement extends number>(requirement: TRequirement): MinCodePointsAction<TInput$1, TRequirement, undefined>;
/**
* Creates a min code points validation action.
*
* @param requirement The minimum code points.
* @param message The error message.
*
* @returns A min code points action.
*/
declare function minCodePoints<TInput$1 extends string, const TRequirement extends number, const TMessage extends ErrorMessage<MinCodePointsIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): MinCodePointsAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/minEntries/minEntries.d.ts
/**
* Min entries issue interface.
*
* @beta
*/
interface MinEntriesIssue<TInput$1 extends EntriesInput, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "min_entries";
  /**
  * The expected property.
  */
  readonly expected: `>=${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The minimum entries.
  */
  readonly requirement: TRequirement;
}
/**
* Min entries action interface.
*
* @beta
*/
interface MinEntriesAction<TInput$1 extends EntriesInput, TRequirement extends number, TMessage extends ErrorMessage<MinEntriesIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, MinEntriesIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "min_entries";
  /**
  * The action reference.
  */
  readonly reference: typeof minEntries;
  /**
  * The expected property.
  */
  readonly expects: `>=${TRequirement}`;
  /**
  * The minimum entries.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a min entries validation action.
*
* @param requirement The minimum entries.
*
* @returns A min entries action.
*
* @beta
*/
declare function minEntries<TInput$1 extends EntriesInput, const TRequirement extends number>(requirement: TRequirement): MinEntriesAction<TInput$1, TRequirement, undefined>;
/**
* Creates a min entries validation action.
*
* @param requirement The minimum entries.
* @param message The error message.
*
* @returns A min entries action.
*
* @beta
*/
declare function minEntries<TInput$1 extends EntriesInput, const TRequirement extends number, const TMessage extends ErrorMessage<MinEntriesIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): MinEntriesAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/minGraphemes/minGraphemes.d.ts
/**
* Min graphemes issue interface.
*/
interface MinGraphemesIssue<TInput$1 extends string, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "min_graphemes";
  /**
  * The expected property.
  */
  readonly expected: `>=${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The minimum graphemes.
  */
  readonly requirement: TRequirement;
}
/**
* Min graphemes action interface.
*/
interface MinGraphemesAction<TInput$1 extends string, TRequirement extends number, TMessage extends ErrorMessage<MinGraphemesIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, MinGraphemesIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "min_graphemes";
  /**
  * The action reference.
  */
  readonly reference: typeof minGraphemes;
  /**
  * The expected property.
  */
  readonly expects: `>=${TRequirement}`;
  /**
  * The minimum graphemes.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a min graphemes validation action.
*
* @param requirement The minimum graphemes.
*
* @returns A min graphemes action.
*/
declare function minGraphemes<TInput$1 extends string, const TRequirement extends number>(requirement: TRequirement): MinGraphemesAction<TInput$1, TRequirement, undefined>;
/**
* Creates a min graphemes validation action.
*
* @param requirement The minimum graphemes.
* @param message The error message.
*
* @returns A min graphemes action.
*/
declare function minGraphemes<TInput$1 extends string, const TRequirement extends number, const TMessage extends ErrorMessage<MinGraphemesIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): MinGraphemesAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/minLength/minLength.d.ts
/**
* Min length issue interface.
*/
interface MinLengthIssue<TInput$1 extends LengthInput, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "min_length";
  /**
  * The expected property.
  */
  readonly expected: `>=${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The minimum length.
  */
  readonly requirement: TRequirement;
}
/**
* Min length action interface.
*/
interface MinLengthAction<TInput$1 extends LengthInput, TRequirement extends number, TMessage extends ErrorMessage<MinLengthIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, MinLengthIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "min_length";
  /**
  * The action reference.
  */
  readonly reference: typeof minLength;
  /**
  * The expected property.
  */
  readonly expects: `>=${TRequirement}`;
  /**
  * The minimum length.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a min length validation action.
*
* @param requirement The minimum length.
*
* @returns A min length action.
*/
declare function minLength<TInput$1 extends LengthInput, const TRequirement extends number>(requirement: TRequirement): MinLengthAction<TInput$1, TRequirement, undefined>;
/**
* Creates a min length validation action.
*
* @param requirement The minimum length.
* @param message The error message.
*
* @returns A min length action.
*/
declare function minLength<TInput$1 extends LengthInput, const TRequirement extends number, const TMessage extends ErrorMessage<MinLengthIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): MinLengthAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/minSize/minSize.d.ts
/**
* Min size issue interface.
*/
interface MinSizeIssue<TInput$1 extends SizeInput, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "min_size";
  /**
  * The expected property.
  */
  readonly expected: `>=${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The minimum size.
  */
  readonly requirement: TRequirement;
}
/**
* Min size action interface.
*/
interface MinSizeAction<TInput$1 extends SizeInput, TRequirement extends number, TMessage extends ErrorMessage<MinSizeIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, MinSizeIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "min_size";
  /**
  * The action reference.
  */
  readonly reference: typeof minSize;
  /**
  * The expected property.
  */
  readonly expects: `>=${TRequirement}`;
  /**
  * The minimum size.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a min size validation action.
*
* @param requirement The minimum size.
*
* @returns A min size action.
*/
declare function minSize<TInput$1 extends SizeInput, const TRequirement extends number>(requirement: TRequirement): MinSizeAction<TInput$1, TRequirement, undefined>;
/**
* Creates a min size validation action.
*
* @param requirement The minimum size.
* @param message The error message.
*
* @returns A min size action.
*/
declare function minSize<TInput$1 extends SizeInput, const TRequirement extends number, const TMessage extends ErrorMessage<MinSizeIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): MinSizeAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/minValue/minValue.d.ts
/**
* Min value issue interface.
*/
interface MinValueIssue<TInput$1 extends ValueInput, TRequirement extends ValueInput> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "min_value";
  /**
  * The expected property.
  */
  readonly expected: `>=${string}`;
  /**
  * The minimum value.
  */
  readonly requirement: TRequirement;
}
/**
* Min value action interface.
*/
interface MinValueAction<TInput$1 extends ValueInput, TRequirement extends TInput$1, TMessage extends ErrorMessage<MinValueIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, MinValueIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "min_value";
  /**
  * The action reference.
  */
  readonly reference: typeof minValue;
  /**
  * The expected property.
  */
  readonly expects: `>=${string}`;
  /**
  * The minimum value.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a min value validation action.
*
* @param requirement The minimum value.
*
* @returns A min value action.
*/
declare function minValue<TInput$1 extends ValueInput, const TRequirement extends TInput$1>(requirement: TRequirement): MinValueAction<TInput$1, TRequirement, undefined>;
/**
* Creates a min value validation action.
*
* @param requirement The minimum value.
* @param message The error message.
*
* @returns A min value action.
*/
declare function minValue<TInput$1 extends ValueInput, const TRequirement extends TInput$1, const TMessage extends ErrorMessage<MinValueIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): MinValueAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/minWords/minWords.d.ts
/**
* Min words issue interface.
*/
interface MinWordsIssue<TInput$1 extends string, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "min_words";
  /**
  * The expected property.
  */
  readonly expected: `>=${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The minimum words.
  */
  readonly requirement: TRequirement;
}
/**
* Min words action interface.
*/
interface MinWordsAction<TInput$1 extends string, TLocales extends Intl.LocalesArgument, TRequirement extends number, TMessage extends ErrorMessage<MinWordsIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, MinWordsIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "min_words";
  /**
  * The action reference.
  */
  readonly reference: typeof minWords;
  /**
  * The expected property.
  */
  readonly expects: `>=${TRequirement}`;
  /**
  * The locales to be used.
  */
  readonly locales: TLocales;
  /**
  * The minimum words.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a min words validation action.
*
* @param locales The locales to be used.
* @param requirement The minimum words.
*
* @returns A min words action.
*/
declare function minWords<TInput$1 extends string, TLocales extends Intl.LocalesArgument, const TRequirement extends number>(locales: TLocales, requirement: TRequirement): MinWordsAction<TInput$1, TLocales, TRequirement, undefined>;
/**
* Creates a min words validation action.
*
* @param locales The locales to be used.
* @param requirement The minimum words.
* @param message The error message.
*
* @returns A min words action.
*/
declare function minWords<TInput$1 extends string, TLocales extends Intl.LocalesArgument, const TRequirement extends number, const TMessage extends ErrorMessage<MinWordsIssue<TInput$1, TRequirement>> | undefined>(locales: TLocales, requirement: TRequirement, message: TMessage): MinWordsAction<TInput$1, TLocales, TRequirement, TMessage>;
//#endregion
//#region src/actions/multipleOf/multipleOf.d.ts
/**
* Input type
*/
type Input = number | bigint;
/**
* Multiple of issue interface.
*/
interface MultipleOfIssue<TInput$1 extends Input, TRequirement extends Input> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "multiple_of";
  /**
  * The expected property.
  */
  readonly expected: `%${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${TInput$1}`;
  /**
  * The divisor.
  */
  readonly requirement: TRequirement;
}
/**
* Multiple of action interface.
*/
interface MultipleOfAction<TInput$1 extends Input, TRequirement extends Input, TMessage extends ErrorMessage<MultipleOfIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, MultipleOfIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "multiple_of";
  /**
  * The action reference.
  */
  readonly reference: typeof multipleOf;
  /**
  * The expected property.
  */
  readonly expects: `%${TRequirement}`;
  /**
  * The divisor.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [multiple](https://en.wikipedia.org/wiki/Multiple_(mathematics)) of validation action.
*
* @param requirement The divisor.
*
* @returns A multiple of action.
*/
declare function multipleOf<TInput$1 extends number, const TRequirement extends number>(requirement: TRequirement): MultipleOfAction<TInput$1, TRequirement, undefined>;
/**
* Creates a [multiple](https://en.wikipedia.org/wiki/Multiple_(mathematics)) of validation action.
*
* @param requirement The divisor.
*
* @returns A multiple of action.
*/
declare function multipleOf<TInput$1 extends bigint, const TRequirement extends bigint>(requirement: TRequirement): MultipleOfAction<TInput$1, TRequirement, undefined>;
/**
* Creates a [multiple](https://en.wikipedia.org/wiki/Multiple_(mathematics)) of validation action.
*
* @param requirement The divisor.
* @param message The error message.
*
* @returns A multiple of action.
*/
declare function multipleOf<TInput$1 extends number, const TRequirement extends number, const TMessage extends ErrorMessage<MultipleOfIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): MultipleOfAction<TInput$1, TRequirement, TMessage>;
/**
* Creates a [multiple](https://en.wikipedia.org/wiki/Multiple_(mathematics)) of validation action.
*
* @param requirement The divisor.
* @param message The error message.
*
* @returns A multiple of action.
*/
declare function multipleOf<TInput$1 extends bigint, const TRequirement extends bigint, const TMessage extends ErrorMessage<MultipleOfIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): MultipleOfAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/nanoid/nanoid.d.ts
/**
* Nano ID issue interface.
*/
interface NanoIdIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "nanoid";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: string;
  /**
  * The Nano ID regex.
  */
  readonly requirement: RegExp;
}
/**
* Nano ID issue type.
*
* @deprecated Use `NanoIdIssue` instead.
*/
type NanoIDIssue<TInput$1 extends string> = NanoIdIssue<TInput$1>;
/**
* Nano ID action interface.
*/
interface NanoIdAction<TInput$1 extends string, TMessage extends ErrorMessage<NanoIdIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, NanoIdIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "nanoid";
  /**
  * The action reference.
  */
  readonly reference: typeof nanoid;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The Nano ID regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Nano ID action type.
*
* @deprecated Use `NanoIdAction` instead.
*/
type NanoIDAction<TInput$1 extends string, TMessage extends ErrorMessage<NanoIdIssue<TInput$1>> | undefined> = NanoIdAction<TInput$1, TMessage>;
/**
* Creates a [Nano ID](https://github.com/ai/nanoid) validation action.
*
* @returns A Nano ID action.
*/
declare function nanoid<TInput$1 extends string>(): NanoIdAction<TInput$1, undefined>;
/**
* Creates a [Nano ID](https://github.com/ai/nanoid) validation action.
*
* @param message The error message.
*
* @returns A Nano ID action.
*/
declare function nanoid<TInput$1 extends string, const TMessage extends ErrorMessage<NanoIdIssue<TInput$1>> | undefined>(message: TMessage): NanoIdAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/nonEmpty/nonEmpty.d.ts
/**
* Non empty issue interface.
*/
interface NonEmptyIssue<TInput$1 extends LengthInput> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "non_empty";
  /**
  * The expected input.
  */
  readonly expected: "!0";
  /**
  * The received input.
  */
  readonly received: "0";
}
/**
* Non empty action interface.
*/
interface NonEmptyAction<TInput$1 extends LengthInput, TMessage extends ErrorMessage<NonEmptyIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, NonEmptyIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "non_empty";
  /**
  * The action reference.
  */
  readonly reference: typeof nonEmpty;
  /**
  * The expected property.
  */
  readonly expects: "!0";
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a non-empty validation action.
*
* @returns A non-empty action.
*/
declare function nonEmpty<TInput$1 extends LengthInput>(): NonEmptyAction<TInput$1, undefined>;
/**
* Creates a non-empty validation action.
*
* @param message The error message.
*
* @returns A non-empty action.
*/
declare function nonEmpty<TInput$1 extends LengthInput, const TMessage extends ErrorMessage<NonEmptyIssue<TInput$1>> | undefined>(message: TMessage): NonEmptyAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/normalize/normalize.d.ts
/**
* Normalize form type.
*/
type NormalizeForm = "NFC" | "NFD" | "NFKC" | "NFKD";
/**
* Normalize action interface.
*/
interface NormalizeAction<TForm extends NormalizeForm | undefined> extends BaseTransformation<string, string, never> {
  /**
  * The action type.
  */
  readonly type: "normalize";
  /**
  * The action reference.
  */
  readonly reference: typeof normalize;
  /**
  * The normalization form.
  */
  readonly form: TForm;
}
/**
* Creates a normalize transformation action.
*
* @returns A normalize action.
*/
declare function normalize(): NormalizeAction<undefined>;
/**
* Creates a normalize transformation action.
*
* @param form The normalization form.
*
* @returns A normalize action.
*/
declare function normalize<TForm extends NormalizeForm | undefined>(form: TForm): NormalizeAction<TForm>;
//#endregion
//#region src/actions/notBytes/notBytes.d.ts
/**
* Not bytes issue interface.
*/
interface NotBytesIssue<TInput$1 extends string, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "not_bytes";
  /**
  * The expected property.
  */
  readonly expected: `!${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The not required bytes.
  */
  readonly requirement: TRequirement;
}
/**
* Not bytes action interface.
*/
interface NotBytesAction<TInput$1 extends string, TRequirement extends number, TMessage extends ErrorMessage<NotBytesIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, NotBytesIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "not_bytes";
  /**
  * The action reference.
  */
  readonly reference: typeof notBytes;
  /**
  * The expected property.
  */
  readonly expects: `!${TRequirement}`;
  /**
  * The not required bytes.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a not [bytes](https://en.wikipedia.org/wiki/Byte) validation action.
*
* @param requirement The not required bytes.
*
* @returns A not bytes action.
*/
declare function notBytes<TInput$1 extends string, const TRequirement extends number>(requirement: TRequirement): NotBytesAction<TInput$1, TRequirement, undefined>;
/**
* Creates a not [bytes](https://en.wikipedia.org/wiki/Byte) validation action.
*
* @param requirement The not required bytes.
* @param message The error message.
*
* @returns A not bytes action.
*/
declare function notBytes<TInput$1 extends string, const TRequirement extends number, const TMessage extends ErrorMessage<NotBytesIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): NotBytesAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/notCodePoints/notCodePoints.d.ts
/**
* Not code points issue interface.
*/
interface NotCodePointsIssue<TInput$1 extends string, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "not_code_points";
  /**
  * The expected property.
  */
  readonly expected: `!${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The not required code points.
  */
  readonly requirement: TRequirement;
}
/**
* Not code points action interface.
*/
interface NotCodePointsAction<TInput$1 extends string, TRequirement extends number, TMessage extends ErrorMessage<NotCodePointsIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, NotCodePointsIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "not_code_points";
  /**
  * The action reference.
  */
  readonly reference: typeof notCodePoints;
  /**
  * The expected property.
  */
  readonly expects: `!${TRequirement}`;
  /**
  * The not required code points.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a not code points validation action.
*
* @param requirement The not required code points.
*
* @returns A not code points action.
*/
declare function notCodePoints<TInput$1 extends string, const TRequirement extends number>(requirement: TRequirement): NotCodePointsAction<TInput$1, TRequirement, undefined>;
/**
* Creates a not code points validation action.
*
* @param requirement The not required code points.
* @param message The error message.
*
* @returns A not code points action.
*/
declare function notCodePoints<TInput$1 extends string, const TRequirement extends number, const TMessage extends ErrorMessage<NotCodePointsIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): NotCodePointsAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/notEntries/notEntries.d.ts
/**
* Not entries issue interface.
*
* @beta
*/
interface NotEntriesIssue<TInput$1 extends EntriesInput, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "not_entries";
  /**
  * The expected property.
  */
  readonly expected: `!${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The not required entries.
  */
  readonly requirement: TRequirement;
}
/**
* Not entries action interface.
*
* @beta
*/
interface NotEntriesAction<TInput$1 extends EntriesInput, TRequirement extends number, TMessage extends ErrorMessage<NotEntriesIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, NotEntriesIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "not_entries";
  /**
  * The action reference.
  */
  readonly reference: typeof notEntries;
  /**
  * The expected property.
  */
  readonly expects: `!${TRequirement}`;
  /**
  * The not required entries.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a not entries validation action.
*
* @param requirement The not required entries.
*
* @returns A not entries action.
*
* @beta
*/
declare function notEntries<TInput$1 extends EntriesInput, const TRequirement extends number>(requirement: TRequirement): NotEntriesAction<TInput$1, TRequirement, undefined>;
/**
* Creates a not entries validation action.
*
* @param requirement The not required entries.
* @param message The error message.
*
* @returns A not entries action.
*
* @beta
*/
declare function notEntries<TInput$1 extends EntriesInput, const TRequirement extends number, const TMessage extends ErrorMessage<NotEntriesIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): NotEntriesAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/notGraphemes/notGraphemes.d.ts
/**
* Not graphemes issue interface.
*/
interface NotGraphemesIssue<TInput$1 extends string, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "not_graphemes";
  /**
  * The expected property.
  */
  readonly expected: `!${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The not required graphemes.
  */
  readonly requirement: TRequirement;
}
/**
* Not graphemes action interface.
*/
interface NotGraphemesAction<TInput$1 extends string, TRequirement extends number, TMessage extends ErrorMessage<NotGraphemesIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, NotGraphemesIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "not_graphemes";
  /**
  * The action reference.
  */
  readonly reference: typeof notGraphemes;
  /**
  * The expected property.
  */
  readonly expects: `!${TRequirement}`;
  /**
  * The not required graphemes.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a not graphemes validation action.
*
* @param requirement The not required graphemes.
*
* @returns A not graphemes action.
*/
declare function notGraphemes<TInput$1 extends string, const TRequirement extends number>(requirement: TRequirement): NotGraphemesAction<TInput$1, TRequirement, undefined>;
/**
* Creates a not graphemes validation action.
*
* @param requirement The not required graphemes.
* @param message The error message.
*
* @returns A not graphemes action.
*/
declare function notGraphemes<TInput$1 extends string, const TRequirement extends number, const TMessage extends ErrorMessage<NotGraphemesIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): NotGraphemesAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/notLength/notLength.d.ts
/**
* Not length issue interface.
*/
interface NotLengthIssue<TInput$1 extends LengthInput, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "not_length";
  /**
  * The expected property.
  */
  readonly expected: `!${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${TRequirement}`;
  /**
  * The not required length.
  */
  readonly requirement: TRequirement;
}
/**
* Not length action interface.
*/
interface NotLengthAction<TInput$1 extends LengthInput, TRequirement extends number, TMessage extends ErrorMessage<NotLengthIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, NotLengthIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "not_length";
  /**
  * The action reference.
  */
  readonly reference: typeof notLength;
  /**
  * The expected property.
  */
  readonly expects: `!${TRequirement}`;
  /**
  * The not required length.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a not length validation action.
*
* @param requirement The not required length.
*
* @returns A not length action.
*/
declare function notLength<TInput$1 extends LengthInput, const TRequirement extends number>(requirement: TRequirement): NotLengthAction<TInput$1, TRequirement, undefined>;
/**
* Creates a not length validation action.
*
* @param requirement The not required length.
* @param message The error message.
*
* @returns A not length action.
*/
declare function notLength<TInput$1 extends LengthInput, const TRequirement extends number, const TMessage extends ErrorMessage<NotLengthIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): NotLengthAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/notSize/notSize.d.ts
/**
* Not size issue interface.
*/
interface NotSizeIssue<TInput$1 extends SizeInput, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "not_size";
  /**
  * The expected property.
  */
  readonly expected: `!${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${TRequirement}`;
  /**
  * The not required size.
  */
  readonly requirement: TRequirement;
}
/**
* Not size action interface.
*/
interface NotSizeAction<TInput$1 extends SizeInput, TRequirement extends number, TMessage extends ErrorMessage<NotSizeIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, NotSizeIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "not_size";
  /**
  * The action reference.
  */
  readonly reference: typeof notSize;
  /**
  * The expected property.
  */
  readonly expects: `!${TRequirement}`;
  /**
  * The not required size.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a not size validation action.
*
* @param requirement The not required size.
*
* @returns A not size action.
*/
declare function notSize<TInput$1 extends SizeInput, const TRequirement extends number>(requirement: TRequirement): NotSizeAction<TInput$1, TRequirement, undefined>;
/**
* Creates a not size validation action.
*
* @param requirement The not required size.
* @param message The error message.
*
* @returns A not size action.
*/
declare function notSize<TInput$1 extends SizeInput, const TRequirement extends number, const TMessage extends ErrorMessage<NotSizeIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): NotSizeAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/notValue/notValue.d.ts
/**
* Not value issue interface.
*/
interface NotValueIssue<TInput$1 extends ValueInput, TRequirement extends TInput$1> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "not_value";
  /**
  * The expected property.
  */
  readonly expected: `!${string}`;
  /**
  * The not required value.
  */
  readonly requirement: TRequirement;
}
/**
* Not value action interface.
*/
interface NotValueAction<TInput$1 extends ValueInput, TRequirement extends TInput$1, TMessage extends ErrorMessage<NotValueIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, NotValueIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "not_value";
  /**
  * The action reference.
  */
  readonly reference: typeof notValue;
  /**
  * The expected property.
  */
  readonly expects: `!${string}`;
  /**
  * The not required value.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a not value validation action.
*
* @param requirement The not required value.
*
* @returns A not value action.
*/
declare function notValue<TInput$1 extends ValueInput, const TRequirement extends TInput$1>(requirement: TRequirement): NotValueAction<TInput$1, TRequirement, undefined>;
/**
* Creates a not value validation action.
*
* @param requirement The not required value.
* @param message The error message.
*
* @returns A not value action.
*/
declare function notValue<TInput$1 extends ValueInput, const TRequirement extends TInput$1, const TMessage extends ErrorMessage<NotValueIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): NotValueAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/notValues/notValues.d.ts
/**
* Not values issue type.
*/
interface NotValuesIssue<TInput$1 extends ValueInput, TRequirement extends readonly TInput$1[]> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "not_values";
  /**
  * The expected property.
  */
  readonly expected: `!${string}`;
  /**
  * The not required values.
  */
  readonly requirement: TRequirement;
}
/**
* Not values action type.
*/
interface NotValuesAction<TInput$1 extends ValueInput, TRequirement extends readonly TInput$1[], TMessage extends ErrorMessage<NotValuesIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, NotValuesIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "not_values";
  /**
  * The action reference.
  */
  readonly reference: typeof notValues;
  /**
  * The expected property.
  */
  readonly expects: `!${string}`;
  /**
  * The not required values.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a not values validation action.
*
* @param requirement The not required values.
*
* @returns A not values action.
*/
declare function notValues<TInput$1 extends ValueInput, const TRequirement extends readonly TInput$1[]>(requirement: TRequirement): NotValuesAction<TInput$1, TRequirement, undefined>;
/**
* Creates a not values validation action.
*
* @param requirement The not required values.
* @param message The error message.
*
* @returns A not values action.
*/
declare function notValues<TInput$1 extends ValueInput, const TRequirement extends readonly TInput$1[], const TMessage extends ErrorMessage<NotValuesIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): NotValuesAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/notWords/notWords.d.ts
/**
* Not words issue interface.
*/
interface NotWordsIssue<TInput$1 extends string, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "not_words";
  /**
  * The expected property.
  */
  readonly expected: `!${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The not required words.
  */
  readonly requirement: TRequirement;
}
/**
* Not words action interface.
*/
interface NotWordsAction<TInput$1 extends string, TLocales extends Intl.LocalesArgument, TRequirement extends number, TMessage extends ErrorMessage<NotWordsIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, NotWordsIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "not_words";
  /**
  * The action reference.
  */
  readonly reference: typeof notWords;
  /**
  * The expected property.
  */
  readonly expects: `!${TRequirement}`;
  /**
  * The locales to be used.
  */
  readonly locales: TLocales;
  /**
  * The not required words.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a not words validation action.
*
* @param locales The locales to be used.
* @param requirement The not required words.
*
* @returns A not words action.
*/
declare function notWords<TInput$1 extends string, TLocales extends Intl.LocalesArgument, const TRequirement extends number>(locales: TLocales, requirement: TRequirement): NotWordsAction<TInput$1, TLocales, TRequirement, undefined>;
/**
* Creates a not words validation action.
*
* @param locales The locales to be used.
* @param requirement The not required words.
* @param message The error message.
*
* @returns A not words action.
*/
declare function notWords<TInput$1 extends string, TLocales extends Intl.LocalesArgument, const TRequirement extends number, const TMessage extends ErrorMessage<NotWordsIssue<TInput$1, TRequirement>> | undefined>(locales: TLocales, requirement: TRequirement, message: TMessage): NotWordsAction<TInput$1, TLocales, TRequirement, TMessage>;
//#endregion
//#region src/actions/octal/octal.d.ts
/**
* Octal issue interface.
*/
interface OctalIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "octal";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The octal regex.
  */
  readonly requirement: RegExp;
}
/**
* Octal action interface.
*/
interface OctalAction<TInput$1 extends string, TMessage extends ErrorMessage<OctalIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, OctalIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "octal";
  /**
  * The action reference.
  */
  readonly reference: typeof octal;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The octal regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [octal](https://en.wikipedia.org/wiki/Octal) validation action.
*
* @returns An octal action.
*/
declare function octal<TInput$1 extends string>(): OctalAction<TInput$1, undefined>;
/**
* Creates an [octal](https://en.wikipedia.org/wiki/Octal) validation action.
*
* @param message The error message.
*
* @returns An octal action.
*/
declare function octal<TInput$1 extends string, const TMessage extends ErrorMessage<OctalIssue<TInput$1>> | undefined>(message: TMessage): OctalAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/parseBoolean/parseBoolean.d.ts
/**
* Parse boolean config interface.
*
* @beta
*/
interface ParseBooleanConfig {
  /**
  * The truthy values.
  */
  truthy?: MaybeReadonly<unknown[]> | undefined;
  /**
  * The falsy values.
  */
  falsy?: MaybeReadonly<unknown[]> | undefined;
}
/**
* Parse boolean issue interface.
*
* @beta
*/
interface ParseBooleanIssue<TInput$1> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "transformation";
  /**
  * The issue type.
  */
  readonly type: "parse_boolean";
  /**
  * The expected property.
  */
  readonly expected: string;
}
/**
* Parse boolean action interface.
*
* @beta
*/
interface ParseBooleanAction<TInput$1, TConfig extends ParseBooleanConfig | undefined, TMessage extends ErrorMessage<ParseBooleanIssue<TInput$1>> | undefined = undefined> extends BaseTransformation<TInput$1, boolean, ParseBooleanIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "parse_boolean";
  /**
  * The action reference.
  */
  readonly reference: typeof parseBoolean;
  /**
  * The expected property.
  */
  readonly expects: string;
  /**
  * The parse boolean config.
  */
  readonly config: TConfig;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a parse boolean transformation action.
*
* @returns A parse boolean action.
*
* @beta
*/
declare function parseBoolean<TInput$1>(): ParseBooleanAction<TInput$1, undefined, undefined>;
/**
* Creates a parse boolean transformation action.
*
* @param config The parse boolean config.
*
* @returns A parse boolean action.
*
* @beta
*/
declare function parseBoolean<TInput$1, const TConfig extends ParseBooleanConfig | undefined>(config: TConfig): ParseBooleanAction<TInput$1, TConfig, undefined>;
/**
* Creates a parse boolean transformation action.
*
* @param config The parse boolean config.
* @param message The error message.
*
* @returns A parse boolean action.
*
* @beta
*/
declare function parseBoolean<TInput$1, const TConfig extends ParseBooleanConfig | undefined, const TMessage extends ErrorMessage<ParseBooleanIssue<TInput$1>> | undefined>(config: TConfig, message: TMessage): ParseBooleanAction<TInput$1, TConfig, TMessage>;
//#endregion
//#region src/actions/parseJson/parseJson.d.ts
/**
* Parse JSON config interface.
*
* @beta
*/
interface ParseJsonConfig {
  /**
  * The JSON reviver function.
  */
  reviver?: (this: any, key: string, value: any) => any;
}
/**
* Parse JSON issue interface.
*
* @beta
*/
interface ParseJsonIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "transformation";
  /**
  * The issue type.
  */
  readonly type: "parse_json";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
}
/**
* Parse JSON action interface.
*
* @beta
*/
interface ParseJsonAction<TInput$1 extends string, TConfig extends ParseJsonConfig | undefined, TMessage extends ErrorMessage<ParseJsonIssue<TInput$1>> | undefined> extends BaseTransformation<TInput$1, unknown, ParseJsonIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "parse_json";
  /**
  * The action reference.
  */
  readonly reference: typeof parseJson;
  /**
  * The action config.
  */
  readonly config: TConfig;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a parse JSON transformation action.
*
* @returns A parse JSON action.
*
* @beta
*/
declare function parseJson<TInput$1 extends string>(): ParseJsonAction<TInput$1, undefined, undefined>;
/**
* Creates a parse JSON transformation action.
*
* @param config The action config.
*
* @returns A parse JSON action.
*
* @beta
*/
declare function parseJson<TInput$1 extends string, const TConfig extends ParseJsonConfig | undefined>(config: TConfig): ParseJsonAction<TInput$1, TConfig, undefined>;
/**
* Creates a parse JSON transformation action.
*
* @param config The action config.
* @param message The error message.
*
* @returns A parse JSON action.
*
* @beta
*/
declare function parseJson<TInput$1 extends string, const TConfig extends ParseJsonConfig | undefined, const TMessage extends ErrorMessage<ParseJsonIssue<TInput$1>> | undefined>(config: TConfig, message: TMessage): ParseJsonAction<TInput$1, TConfig, TMessage>;
//#endregion
//#region src/actions/partialCheck/types.d.ts
/**
* Partial input type.
*/
type PartialInput = Record<string, unknown> | ArrayLike<unknown>;
/**
* Partial check issue interface.
*/
interface PartialCheckIssue<TInput$1 extends PartialInput> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "partial_check";
  /**
  * The expected input.
  */
  readonly expected: null;
  /**
  * The validation function.
  */
  readonly requirement: (input: TInput$1) => MaybePromise<boolean>;
}
/**
* Extracts the exact keys of a tuple, array or object.
*/
type KeyOf<TValue$1> = IsAny<TValue$1> extends true ? never : TValue$1 extends readonly unknown[] ? number extends TValue$1["length"] ? "$" : { [TKey in keyof TValue$1]: TKey extends `${infer TIndex extends number}` ? TIndex : never }[number] : TValue$1 extends Record<string, unknown> ? keyof TValue$1 & (string | number) : never;
/**
* Path type.
*/
type Path = readonly (string | number)[];
/**
* Required path type.
*/
type RequiredPath = readonly [string | number, ...Path];
/**
* Paths type.
*/
type Paths = readonly RequiredPath[];
/**
* Required paths type.
*/
type RequiredPaths = readonly [RequiredPath, ...RequiredPath[]];
/**
* Lazily evaluate only the first valid path segment based on the given value.
*/
type LazyPath<TValue$1, TPathToCheck extends Path, TValidPath extends Path = readonly []> = TPathToCheck extends readonly [] ? TValidPath : TPathToCheck extends readonly [infer TFirstKey extends KeyOf<TValue$1>, ...infer TPathRest extends Path] ? LazyPath<TFirstKey extends keyof TValue$1 ? TValue$1[TFirstKey] : TFirstKey extends "$" ? TValue$1 extends readonly unknown[] ? TValue$1[number] : never : never, TPathRest, readonly [...TValidPath, TFirstKey]> : IsNever<KeyOf<TValue$1>> extends false ? readonly [...TValidPath, KeyOf<TValue$1>] : TValidPath;
/**
* Returns the path if valid, otherwise the first possible valid path based on
* the given value.
*/
type ValidPath<TValue$1, TPath extends RequiredPath> = TPath extends LazyPath<TValue$1, TPath> ? TPath : LazyPath<TValue$1, TPath>;
/**
* Returns a valid path for any given path based on the given value.
*/
type ValidPaths<TValue$1, TPaths extends RequiredPaths> = { [TKey in keyof TPaths]: ValidPath<TValue$1, TPaths[TKey]> };
/**
* Deeply picks specific keys.
*
* Hint: If this type is ever exported and accessible from the outside, it must
* be wrapped in `UnionToIntersect` to avoid invalid results.
*/
type DeepPick<TValue$1, TPath extends Path> = TPath extends readonly [infer TFirstKey extends string | number, ...infer TPathRest extends Path] ? TValue$1 extends readonly unknown[] ? number extends TValue$1["length"] ? TPathRest extends readonly [] ? TValue$1 : DeepPick<TValue$1[number], TPathRest>[] : { [TKey in keyof TValue$1]: TKey extends `${TFirstKey}` ? TPathRest extends readonly [] ? TValue$1[TKey] : DeepPick<TValue$1[TKey], TPathRest> : unknown } : { [TKey in keyof TValue$1 as TKey extends TFirstKey ? TKey : never]: TPathRest extends readonly [] ? TValue$1[TKey] : DeepPick<TValue$1[TKey], TPathRest> } : never;
/**
* Deeply merges two types.
*/
type DeepMerge<TValue1, TValue2> = TValue1 extends readonly unknown[] ? TValue2 extends readonly unknown[] ? number extends TValue1["length"] | TValue2["length"] ? DeepMerge<TValue1[number], TValue2[number]>[] : { [TKey in keyof TValue1]: TKey extends keyof TValue2 ? unknown extends TValue1[TKey] ? TValue2[TKey] : TValue1[TKey] : never } : never : TValue1 extends Record<string, unknown> ? TValue2 extends Record<string, unknown> ? { [TKey in keyof (TValue1 & TValue2)]: TKey extends keyof TValue1 ? TKey extends keyof TValue2 ? DeepMerge<TValue1[TKey], TValue2[TKey]> : TValue1[TKey] : TKey extends keyof TValue2 ? TValue2[TKey] : never } : never : TValue1 & TValue2;
/**
* Deeply picks N specific keys.
*/
type DeepPickN<TInput$1, TPaths extends Paths> = TPaths extends readonly [infer TFirstPath extends Path, ...infer TRestPaths extends Paths] ? TRestPaths extends readonly [] ? DeepPick<TInput$1, TFirstPath> : DeepMerge<DeepPick<TInput$1, TFirstPath>, DeepPickN<TInput$1, TRestPaths>> : TInput$1;
//#endregion
//#region src/actions/partialCheck/partialCheck.d.ts
/**
* Partial check action interface.
*/
interface PartialCheckAction<TInput$1 extends PartialInput, TPaths extends Paths, TSelection extends DeepPickN<TInput$1, TPaths>, TMessage extends ErrorMessage<PartialCheckIssue<TSelection>> | undefined> extends BaseValidation<TInput$1, TInput$1, PartialCheckIssue<TSelection>> {
  /**
  * The action type.
  */
  readonly type: "partial_check";
  /**
  * The action reference.
  */
  readonly reference: typeof partialCheck;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The selected paths.
  */
  readonly paths: TPaths;
  /**
  * The validation function.
  */
  readonly requirement: (input: TSelection) => boolean;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a partial check validation action.
*
* @param paths The selected paths.
* @param requirement The validation function.
*
* @returns A partial check action.
*/
declare function partialCheck<TInput$1 extends PartialInput, const TPaths extends RequiredPaths, const TSelection extends DeepPickN<TInput$1, TPaths>>(paths: ValidPaths<TInput$1, TPaths>, requirement: (input: TSelection) => boolean): PartialCheckAction<TInput$1, TPaths, TSelection, undefined>;
/**
* Creates a partial check validation action.
*
* @param paths The selected paths.
* @param requirement The validation function.
* @param message The error message.
*
* @returns A partial check action.
*/
declare function partialCheck<TInput$1 extends PartialInput, const TPaths extends RequiredPaths, const TSelection extends DeepPickN<TInput$1, TPaths>, const TMessage extends ErrorMessage<PartialCheckIssue<TSelection>> | undefined>(paths: ValidPaths<TInput$1, TPaths>, requirement: (input: TSelection) => boolean, message: TMessage): PartialCheckAction<TInput$1, TPaths, TSelection, TMessage>;
//#endregion
//#region src/actions/partialCheck/partialCheckAsync.d.ts
/**
* Partial check action async interface.
*/
interface PartialCheckActionAsync<TInput$1 extends PartialInput, TPaths extends Paths, TSelection extends DeepPickN<TInput$1, TPaths>, TMessage extends ErrorMessage<PartialCheckIssue<TSelection>> | undefined> extends BaseValidationAsync<TInput$1, TInput$1, PartialCheckIssue<TSelection>> {
  /**
  * The action type.
  */
  readonly type: "partial_check";
  /**
  * The action reference.
  */
  readonly reference: typeof partialCheckAsync;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The selected paths.
  */
  readonly paths: TPaths;
  /**
  * The validation function.
  */
  readonly requirement: (input: TSelection) => MaybePromise<boolean>;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a partial check validation action.
*
* @param paths The selected paths.
* @param requirement The validation function.
*
* @returns A partial check action.
*/
declare function partialCheckAsync<TInput$1 extends PartialInput, const TPaths extends RequiredPaths, const TSelection extends DeepPickN<TInput$1, TPaths>>(paths: ValidPaths<TInput$1, TPaths>, requirement: (input: TSelection) => MaybePromise<boolean>): PartialCheckActionAsync<TInput$1, TPaths, TSelection, undefined>;
/**
* Creates a partial check validation action.
*
* @param paths The selected paths.
* @param requirement The validation function.
* @param message The error message.
*
* @returns A partial check action.
*/
declare function partialCheckAsync<TInput$1 extends PartialInput, const TPaths extends RequiredPaths, const TSelection extends DeepPickN<TInput$1, TPaths>, const TMessage extends ErrorMessage<PartialCheckIssue<TSelection>> | undefined>(paths: ValidPaths<TInput$1, TPaths>, requirement: (input: TSelection) => MaybePromise<boolean>, message: TMessage): PartialCheckActionAsync<TInput$1, TPaths, TSelection, TMessage>;
//#endregion
//#region src/actions/rawCheck/types.d.ts
/**
* Raw check issue interface.
*/
interface RawCheckIssue<TInput$1> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "raw_check";
}
/**
* Raw check issue info interface.
*/
interface RawCheckIssueInfo<TInput$1> {
  label?: string | undefined;
  input?: unknown | undefined;
  expected?: string | undefined;
  received?: string | undefined;
  message?: ErrorMessage<RawCheckIssue<TInput$1>> | undefined;
  path?: [IssuePathItem, ...IssuePathItem[]] | undefined;
}
/**
* Raw check add issue type.
*/
type RawCheckAddIssue<TInput$1> = (info?: RawCheckIssueInfo<TInput$1>) => void;
/**
* Raw check context interface.
*/
interface RawCheckContext<TInput$1> {
  readonly dataset: OutputDataset<TInput$1, BaseIssue<unknown>>;
  readonly config: Config<RawCheckIssue<TInput$1>>;
  readonly addIssue: RawCheckAddIssue<TInput$1>;
}
//#endregion
//#region src/actions/rawCheck/rawCheck.d.ts
/**
* Raw check action interface.
*/
interface RawCheckAction<TInput$1> extends BaseValidation<TInput$1, TInput$1, RawCheckIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "raw_check";
  /**
  * The action reference.
  */
  readonly reference: typeof rawCheck;
  /**
  * The expected property.
  */
  readonly expects: null;
}
/**
* Creates a raw check validation action.
*
* @param action The validation action.
*
* @returns A raw check action.
*/
declare function rawCheck<TInput$1>(action: (context: RawCheckContext<TInput$1>) => void): RawCheckAction<TInput$1>;
//#endregion
//#region src/actions/rawCheck/rawCheckAsync.d.ts
/**
* Raw check action async interface.
*/
interface RawCheckActionAsync<TInput$1> extends BaseValidationAsync<TInput$1, TInput$1, RawCheckIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "raw_check";
  /**
  * The action reference.
  */
  readonly reference: typeof rawCheckAsync;
  /**
  * The expected property.
  */
  readonly expects: null;
}
/**
* Creates a raw check validation action.
*
* @param action The validation action.
*
* @returns A raw check action.
*/
declare function rawCheckAsync<TInput$1>(action: (context: RawCheckContext<TInput$1>) => MaybePromise<void>): RawCheckActionAsync<TInput$1>;
//#endregion
//#region src/actions/rawTransform/types.d.ts
/**
* Raw transform issue interface.
*/
interface RawTransformIssue<TInput$1> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "transformation";
  /**
  * The issue type.
  */
  readonly type: "raw_transform";
}
/**
* Raw transform issue info interface.
*/
interface RawTransformIssueInfo<TInput$1> {
  label?: string | undefined;
  input?: unknown | undefined;
  expected?: string | undefined;
  received?: string | undefined;
  message?: ErrorMessage<RawTransformIssue<TInput$1>> | undefined;
  path?: [IssuePathItem, ...IssuePathItem[]] | undefined;
}
/**
* Raw transform add issue type.
*/
type RawTransformAddIssue<TInput$1> = (info?: RawTransformIssueInfo<TInput$1>) => void;
/**
* Raw transform context interface.
*/
interface RawTransformContext<TInput$1> {
  readonly dataset: SuccessDataset<TInput$1>;
  readonly config: Config<RawTransformIssue<TInput$1>>;
  readonly addIssue: RawTransformAddIssue<TInput$1>;
  readonly NEVER: never;
}
//#endregion
//#region src/actions/rawTransform/rawTransform.d.ts
/**
* Raw transform action interface.
*/
interface RawTransformAction<TInput$1, TOutput$1> extends BaseTransformation<TInput$1, TOutput$1, RawTransformIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "raw_transform";
  /**
  * The action reference.
  */
  readonly reference: typeof rawTransform;
}
/**
* Creates a raw transformation action.
*
* @param action The transformation action.
*
* @returns A raw transform action.
*/
declare function rawTransform<TInput$1, TOutput$1>(action: (context: RawTransformContext<TInput$1>) => TOutput$1): RawTransformAction<TInput$1, TOutput$1>;
//#endregion
//#region src/actions/rawTransform/rawTransformAsync.d.ts
/**
* Raw transform action async interface.
*/
interface RawTransformActionAsync<TInput$1, TOutput$1> extends BaseTransformationAsync<TInput$1, TOutput$1, RawTransformIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "raw_transform";
  /**
  * The action reference.
  */
  readonly reference: typeof rawTransformAsync;
}
/**
* Creates a raw transformation action.
*
* @param action The transformation action.
*
* @returns A raw transform action.
*/
declare function rawTransformAsync<TInput$1, TOutput$1>(action: (context: RawTransformContext<TInput$1>) => MaybePromise<TOutput$1>): RawTransformActionAsync<TInput$1, TOutput$1>;
//#endregion
//#region src/actions/readonly/readonly.d.ts
/**
* Readonly output type.
*/
type ReadonlyOutput<TInput$1> = TInput$1 extends Map<infer TKey, infer TValue> ? ReadonlyMap<TKey, TValue> : TInput$1 extends Set<infer TValue> ? ReadonlySet<TValue> : Readonly<TInput$1>;
/**
* Readonly action interface.
*/
interface ReadonlyAction<TInput$1> extends BaseTransformation<TInput$1, ReadonlyOutput<TInput$1>, never> {
  /**
  * The action type.
  */
  readonly type: "readonly";
  /**
  * The action reference.
  */
  readonly reference: typeof readonly;
}
/**
* Creates a readonly transformation action.
*
* @returns A readonly action.
*/
declare function readonly<TInput$1>(): ReadonlyAction<TInput$1>;
//#endregion
//#region src/actions/reduceItems/reduceItems.d.ts
/**
* Array action type.
*/
type ArrayAction$1<TInput$1 extends ArrayInput, TOutput$1> = (output: TOutput$1, item: TInput$1[number], index: number, array: TInput$1) => TOutput$1;
/**
* Reduce items action interface.
*/
interface ReduceItemsAction<TInput$1 extends ArrayInput, TOutput$1> extends BaseTransformation<TInput$1, TOutput$1, never> {
  /**
  * The action type.
  */
  readonly type: "reduce_items";
  /**
  * The action reference.
  */
  readonly reference: typeof reduceItems;
  /**
  * The reduce items operation.
  */
  readonly operation: ArrayAction$1<TInput$1, TOutput$1>;
  /**
  * The initial value.
  */
  readonly initial: TOutput$1;
}
/**
* Creates a reduce items transformation action.
*
* @param operation The reduce items operation.
* @param initial The initial value.
*
* @returns A reduce items action.
*/
declare function reduceItems<TInput$1 extends ArrayInput, TOutput$1>(operation: ArrayAction$1<TInput$1, TOutput$1>, initial: TOutput$1): ReduceItemsAction<TInput$1, TOutput$1>;
//#endregion
//#region src/actions/regex/regex.d.ts
/**
* Regex issue interface.
*/
interface RegexIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "regex";
  /**
  * The expected input.
  */
  readonly expected: string;
  /**
  * The received input.
  */
  readonly received: `"${string}"`;
  /**
  * The regex pattern.
  */
  readonly requirement: RegExp;
}
/**
* Regex action interface.
*/
interface RegexAction<TInput$1 extends string, TMessage extends ErrorMessage<RegexIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, RegexIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "regex";
  /**
  * The action reference.
  */
  readonly reference: typeof regex;
  /**
  * The expected property.
  */
  readonly expects: string;
  /**
  * The regex pattern.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [regex](https://en.wikipedia.org/wiki/Regular_expression) validation action.
*
* Hint: Be careful with the global flag `g` in your regex pattern, as it can lead to unexpected results. See [MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp/test#using_test_on_a_regex_with_the_global_flag) for more information.
*
* @param requirement The regex pattern.
*
* @returns A regex action.
*/
declare function regex<TInput$1 extends string>(requirement: RegExp): RegexAction<TInput$1, undefined>;
/**
* Creates a [regex](https://en.wikipedia.org/wiki/Regular_expression) validation action.
*
* Hint: Be careful with the global flag `g` in your regex pattern, as it can lead to unexpected results. See [MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp/test#using_test_on_a_regex_with_the_global_flag) for more information.
*
* @param requirement The regex pattern.
* @param message The error message.
*
* @returns A regex action.
*/
declare function regex<TInput$1 extends string, const TMessage extends ErrorMessage<RegexIssue<TInput$1>> | undefined>(requirement: RegExp, message: TMessage): RegexAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/returns/returns.d.ts
/**
* Returns action type.
*/
interface ReturnsAction<TInput$1 extends (...args: any[]) => unknown, TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>> extends BaseTransformation<TInput$1, (...args: Parameters<TInput$1>) => InferOutput<TSchema>, never> {
  /**
  * The action type.
  */
  readonly type: "returns";
  /**
  * The action reference.
  */
  readonly reference: typeof returns;
  /**
  * The arguments schema.
  */
  readonly schema: TSchema;
}
/**
* Creates a function return transformation action.
*
* @param schema The arguments schema.
*
* @returns An returns action.
*/
declare function returns<TInput$1 extends (...args: any[]) => unknown, TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema): ReturnsAction<TInput$1, TSchema>;
//#endregion
//#region src/actions/returns/returnsAsync.d.ts
/**
* Returns action async type.
*/
interface ReturnsActionAsync<TInput$1 extends (...args: any[]) => unknown, TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> extends BaseTransformation<TInput$1, (...args: Parameters<TInput$1>) => Promise<Awaited<InferOutput<TSchema>>>, never> {
  /**
  * The action type.
  */
  readonly type: "returns";
  /**
  * The action reference.
  */
  readonly reference: typeof returnsAsync;
  /**
  * The arguments schema.
  */
  readonly schema: TSchema;
}
/**
* Creates a function arguments transformation action.
*
* @param schema The arguments schema.
*
* @returns An returns action.
*/
declare function returnsAsync<TInput$1 extends (...args: any[]) => unknown, TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema): ReturnsActionAsync<TInput$1, TSchema>;
//#endregion
//#region src/actions/rfcEmail/rfcEmail.d.ts
/**
* RFC email issue interface.
*/
interface RfcEmailIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "rfc_email";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The RFC email regex.
  */
  readonly requirement: RegExp;
}
/**
* RFC email action interface.
*/
interface RfcEmailAction<TInput$1 extends string, TMessage extends ErrorMessage<RfcEmailIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, RfcEmailIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "rfc_email";
  /**
  * The action reference.
  */
  readonly reference: typeof rfcEmail;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The RFC email regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [RFC email](https://datatracker.ietf.org/doc/html/rfc5322#section-3.4.1)
* validation action.
*
* Hint: This validation action uses the regex defined by the HTML Living
* Standard for `<input type="email">`, which covers most of RFC 5322 but
* not all of it. For example, quoted local parts and comments are not
* supported. If you are interested in an action that only validates common
* email addresses, please use the `email` action instead.
*
* @returns A RFC email action.
*/
declare function rfcEmail<TInput$1 extends string>(): RfcEmailAction<TInput$1, undefined>;
/**
* Creates a [RFC email](https://datatracker.ietf.org/doc/html/rfc5322#section-3.4.1)
* validation action.
*
* Hint: This validation action uses the regex defined by the HTML Living
* Standard for `<input type="email">`, which covers most of RFC 5322 but
* not all of it. For example, quoted local parts and comments are not
* supported. If you are interested in an action that only validates common
* email addresses, please use the `email` action instead.
*
* @param message The error message.
*
* @returns A RFC email action.
*/
declare function rfcEmail<TInput$1 extends string, const TMessage extends ErrorMessage<RfcEmailIssue<TInput$1>> | undefined>(message: TMessage): RfcEmailAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/safeInteger/safeInteger.d.ts
/**
* Safe integer issue interface.
*/
interface SafeIntegerIssue<TInput$1 extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "safe_integer";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The validation function.
  */
  readonly requirement: (input: number) => boolean;
}
/**
* Safe integer action interface.
*/
interface SafeIntegerAction<TInput$1 extends number, TMessage extends ErrorMessage<SafeIntegerIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, SafeIntegerIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "safe_integer";
  /**
  * The action reference.
  */
  readonly reference: typeof safeInteger;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The validation function.
  */
  readonly requirement: (input: number) => boolean;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a safe integer validation action.
*
* @returns A safe integer action.
*/
declare function safeInteger<TInput$1 extends number>(): SafeIntegerAction<TInput$1, undefined>;
/**
* Creates a safe integer validation action.
*
* @param message The error message.
*
* @returns A safe integer action.
*/
declare function safeInteger<TInput$1 extends number, const TMessage extends ErrorMessage<SafeIntegerIssue<TInput$1>> | undefined>(message: TMessage): SafeIntegerAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/size/size.d.ts
/**
* Size issue interface.
*/
interface SizeIssue<TInput$1 extends SizeInput, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "size";
  /**
  * The expected property.
  */
  readonly expected: `${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The required size.
  */
  readonly requirement: TRequirement;
}
/**
* Size action interface.
*/
interface SizeAction<TInput$1 extends SizeInput, TRequirement extends number, TMessage extends ErrorMessage<SizeIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, SizeIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "size";
  /**
  * The action reference.
  */
  readonly reference: typeof size;
  /**
  * The expected property.
  */
  readonly expects: `${TRequirement}`;
  /**
  * The required size.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a size validation action.
*
* @param requirement The required size.
*
* @returns A size action.
*/
declare function size<TInput$1 extends SizeInput, const TRequirement extends number>(requirement: TRequirement): SizeAction<TInput$1, TRequirement, undefined>;
/**
* Creates a size validation action.
*
* @param requirement The required size.
* @param message The error message.
*
* @returns A size action.
*/
declare function size<TInput$1 extends SizeInput, const TRequirement extends number, const TMessage extends ErrorMessage<SizeIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): SizeAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/slug/slug.d.ts
/**
* Slug issue type.
*/
interface SlugIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "slug";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The slug regex.
  */
  readonly requirement: RegExp;
}
/**
* Slug action type.
*/
interface SlugAction<TInput$1 extends string, TMessage extends ErrorMessage<SlugIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, SlugIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "slug";
  /**
  * The action reference.
  */
  readonly reference: typeof slug;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The slug regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [slug](https://en.wikipedia.org/wiki/Clean_URL#Slug) validation action.
*
* @returns A slug action.
*/
declare function slug<TInput$1 extends string>(): SlugAction<TInput$1, undefined>;
/**
* Creates a [slug](https://en.wikipedia.org/wiki/Clean_URL#Slug) validation action.
*
* @param message The error message.
*
* @returns A slug action.
*/
declare function slug<TInput$1 extends string, const TMessage extends ErrorMessage<SlugIssue<TInput$1>> | undefined>(message: TMessage): SlugAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/someItem/someItem.d.ts
/**
* Some item issue interface.
*/
interface SomeItemIssue<TInput$1 extends ArrayInput> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "some_item";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The validation function.
  */
  readonly requirement: ArrayRequirement<TInput$1>;
}
/**
* Some item action interface.
*/
interface SomeItemAction<TInput$1 extends ArrayInput, TMessage extends ErrorMessage<SomeItemIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, SomeItemIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "some_item";
  /**
  * The action reference.
  */
  readonly reference: typeof someItem;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The validation function.
  */
  readonly requirement: ArrayRequirement<TInput$1>;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a some item validation action.
*
* @param requirement The validation function.
*
* @returns A some item action.
*/
declare function someItem<TInput$1 extends ArrayInput>(requirement: ArrayRequirement<TInput$1>): SomeItemAction<TInput$1, undefined>;
/**
* Creates a some item validation action.
*
* @param requirement The validation function.
* @param message The error message.
*
* @returns A some item action.
*/
declare function someItem<TInput$1 extends ArrayInput, const TMessage extends ErrorMessage<SomeItemIssue<TInput$1>> | undefined>(requirement: ArrayRequirement<TInput$1>, message: TMessage): SomeItemAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/sortItems/sortItems.d.ts
/**
* Array action type.
*/
type ArrayAction<TInput$1 extends ArrayInput> = (itemA: TInput$1[number], itemB: TInput$1[number]) => number;
/**
* Sort items action interface.
*/
interface SortItemsAction<TInput$1 extends ArrayInput> extends BaseTransformation<TInput$1, TInput$1, never> {
  /**
  * The action type.
  */
  readonly type: "sort_items";
  /**
  * The action reference.
  */
  readonly reference: typeof sortItems;
  /**
  * The sort items operation.
  */
  readonly operation: ArrayAction<TInput$1> | undefined;
}
/**
* Creates a sort items transformation action.
*
* @param operation The sort items operation.
*
* @returns A sort items action.
*/
declare function sortItems<TInput$1 extends ArrayInput>(operation?: ArrayAction<TInput$1>): SortItemsAction<TInput$1>;
//#endregion
//#region src/actions/startsWith/startsWith.d.ts
/**
* Starts with issue interface.
*/
interface StartsWithIssue<TInput$1 extends string, TRequirement extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "starts_with";
  /**
  * The expected property.
  */
  readonly expected: `"${TRequirement}"`;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The start string.
  */
  readonly requirement: TRequirement;
}
/**
* Starts with action interface.
*/
interface StartsWithAction<TInput$1 extends string, TRequirement extends string, TMessage extends ErrorMessage<StartsWithIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, StartsWithIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "starts_with";
  /**
  * The action reference.
  */
  readonly reference: typeof startsWith;
  /**
  * The expected property.
  */
  readonly expects: `"${TRequirement}"`;
  /**
  * The start string.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a starts with validation action.
*
* @param requirement The start string.
*
* @returns A starts with action.
*/
declare function startsWith<TInput$1 extends string, const TRequirement extends string>(requirement: TRequirement): StartsWithAction<TInput$1, TRequirement, undefined>;
/**
* Creates a starts with validation action.
*
* @param requirement The start string.
* @param message The error message.
*
* @returns A starts with action.
*/
declare function startsWith<TInput$1 extends string, const TRequirement extends string, const TMessage extends ErrorMessage<StartsWithIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): StartsWithAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/stringifyJson/stringifyJson.d.ts
/**
* Stringify JSON config interface.
*
* @beta
*/
interface StringifyJsonConfig {
  /**
  * The JSON replacer function or array.
  */
  replacer?: ((this: any, key: string, value: any) => any) | (number | string)[];
  /**
  * The JSON space option.
  */
  space?: string | number;
}
/**
* Stringify JSON issue interface.
*
* @beta
*/
interface StringifyJsonIssue<TInput$1> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "transformation";
  /**
  * The issue type.
  */
  readonly type: "stringify_json";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
}
/**
* Stringify JSON action interface.
*
* @beta
*/
interface StringifyJsonAction<TInput$1, TConfig extends StringifyJsonConfig | undefined, TMessage extends ErrorMessage<StringifyJsonIssue<TInput$1>> | undefined> extends BaseTransformation<TInput$1, string, StringifyJsonIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "stringify_json";
  /**
  * The action reference.
  */
  readonly reference: typeof stringifyJson;
  /**
  * The action config.
  */
  readonly config: TConfig;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a stringify JSON transformation action.
*
* @returns A stringify JSON action.
*
* @beta
*/
declare function stringifyJson<TInput$1>(): StringifyJsonAction<TInput$1, undefined, undefined>;
/**
* Creates a stringify JSON transformation action.
*
* @param config The action config.
*
* @returns A stringify JSON action.
*
* @beta
*/
declare function stringifyJson<TInput$1, const TConfig extends StringifyJsonConfig | undefined>(config: TConfig): StringifyJsonAction<TInput$1, TConfig, undefined>;
/**
* Creates a stringify JSON transformation action.
*
* @param config The action config.
* @param message The error message.
*
* @returns A stringify JSON action.
*
* @beta
*/
declare function stringifyJson<TInput$1, const TConfig extends StringifyJsonConfig | undefined, const TMessage extends ErrorMessage<StringifyJsonIssue<TInput$1>> | undefined>(config: TConfig, message: TMessage): StringifyJsonAction<TInput$1, TConfig, TMessage>;
//#endregion
//#region src/actions/toBigint/toBigint.d.ts
/**
* To bigint issue interface.
*/
interface ToBigintIssue<TInput$1> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "transformation";
  /**
  * The issue type.
  */
  readonly type: "to_bigint";
  /**
  * The expected property.
  */
  readonly expected: null;
}
/**
* To bigint action interface.
*/
interface ToBigintAction<TInput$1, TMessage extends ErrorMessage<ToBigintIssue<TInput$1>> | undefined> extends BaseTransformation<TInput$1, bigint, ToBigintIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "to_bigint";
  /**
  * The action reference.
  */
  readonly reference: typeof toBigint;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a to bigint transformation action.
*
* @returns A to bigint action.
*
* @beta
*/
declare function toBigint<TInput$1>(): ToBigintAction<TInput$1, undefined>;
/**
* Creates a to bigint transformation action.
*
* @param message The error message.
*
* @returns A to bigint action.
*
* @beta
*/
declare function toBigint<TInput$1, const TMessage extends ErrorMessage<ToBigintIssue<TInput$1>> | undefined>(message: TMessage): ToBigintAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/toBoolean/toBoolean.d.ts
/**
* To boolean action interface.
*/
interface ToBooleanAction<TInput$1> extends BaseTransformation<TInput$1, boolean, never> {
  /**
  * The action type.
  */
  readonly type: "to_boolean";
  /**
  * The action reference.
  */
  readonly reference: typeof toBoolean;
}
/**
* Creates a to boolean transformation action.
*
* @returns A to boolean action.
*
* @beta
*/
declare function toBoolean<TInput$1>(): ToBooleanAction<TInput$1>;
//#endregion
//#region src/actions/toCamelCase/toCamelCase.d.ts
/**
* To camel case action interface.
*
* @beta
*/
interface ToCamelCaseAction extends BaseTransformation<string, string, never> {
  /**
  * The action type.
  */
  readonly type: "to_camel_case";
  /**
  * The action reference.
  */
  readonly reference: typeof toCamelCase;
}
/**
* Creates a to camel case transformation action.
*
* Words are separated by `_`, `-` and ASCII whitespace, as well as by case
* and acronym boundaries.
*
* Hint: Acronym runs are normalized to lowercase (e.g. `parseURLValue` →
* `parseUrlValue`) and digits stay attached to the preceding token (e.g.
* `item2Name` → `item2Name`).
*
* @returns A to camel case action.
*
* @beta
*/
declare function toCamelCase(): ToCamelCaseAction;
//#endregion
//#region src/actions/toDate/toDate.d.ts
/**
* To date issue interface.
*/
interface ToDateIssue<TInput$1> extends BaseIssue<TInput$1 | Date> {
  /**
  * The issue kind.
  */
  readonly kind: "transformation";
  /**
  * The issue type.
  */
  readonly type: "to_date";
  /**
  * The expected property.
  */
  readonly expected: null;
}
/**
* To date action interface.
*/
interface ToDateAction<TInput$1, TMessage extends ErrorMessage<ToDateIssue<TInput$1>> | undefined> extends BaseTransformation<TInput$1, Date, ToDateIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "to_date";
  /**
  * The action reference.
  */
  readonly reference: typeof toDate;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a to date transformation action.
*
* @returns A to date action.
*
* @beta
*/
declare function toDate<TInput$1>(): ToDateAction<TInput$1, undefined>;
/**
* Creates a to date transformation action.
*
* @param message The error message.
*
* @returns A to date action.
*
* @beta
*/
declare function toDate<TInput$1, const TMessage extends ErrorMessage<ToDateIssue<TInput$1>> | undefined>(message: TMessage): ToDateAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/toKebabCase/toKebabCase.d.ts
/**
* To kebab case action interface.
*
* @beta
*/
interface ToKebabCaseAction extends BaseTransformation<string, string, never> {
  /**
  * The action type.
  */
  readonly type: "to_kebab_case";
  /**
  * The action reference.
  */
  readonly reference: typeof toKebabCase;
}
/**
* Creates a to kebab case transformation action.
*
* Words are separated by `_`, `-` and ASCII whitespace, as well as by case
* and acronym boundaries.
*
* Hint: Acronym runs are normalized to lowercase (e.g. `parseURLValue` →
* `parse-url-value`) and digits stay attached to the preceding token (e.g.
* `item2Name` → `item2-name`).
*
* @returns A to kebab case action.
*
* @beta
*/
declare function toKebabCase(): ToKebabCaseAction;
//#endregion
//#region src/actions/toLowerCase/toLowerCase.d.ts
/**
* To lower case action interface.
*/
interface ToLowerCaseAction extends BaseTransformation<string, string, never> {
  /**
  * The action type.
  */
  readonly type: "to_lower_case";
  /**
  * The action reference.
  */
  readonly reference: typeof toLowerCase;
}
/**
* Creates a to lower case transformation action.
*
* @returns A to lower case action.
*/
declare function toLowerCase(): ToLowerCaseAction;
//#endregion
//#region src/actions/toMaxValue/toMaxValue.d.ts
/**
* To max value action interface.
*/
interface ToMaxValueAction<TInput$1 extends ValueInput, TRequirement extends TInput$1> extends BaseTransformation<TInput$1, TInput$1, never> {
  /**
  * The action type.
  */
  readonly type: "to_max_value";
  /**
  * The action reference.
  */
  readonly reference: typeof toMaxValue;
  /**
  * The maximum value.
  */
  readonly requirement: TRequirement;
}
/**
* Creates a to max value transformation action.
*
* @param requirement The maximum value.
*
* @returns A to max value action.
*/
declare function toMaxValue<TInput$1 extends ValueInput, const TRequirement extends TInput$1>(requirement: TRequirement): ToMaxValueAction<TInput$1, TRequirement>;
//#endregion
//#region src/actions/toMinValue/toMinValue.d.ts
/**
* To min value action interface.
*/
interface ToMinValueAction<TInput$1 extends ValueInput, TRequirement extends TInput$1> extends BaseTransformation<TInput$1, TInput$1, never> {
  /**
  * The action type.
  */
  readonly type: "to_min_value";
  /**
  * The action reference.
  */
  readonly reference: typeof toMinValue;
  /**
  * The minimum value.
  */
  readonly requirement: TRequirement;
}
/**
* Creates a to min value transformation action.
*
* @param requirement The minimum value.
*
* @returns A to min value action.
*/
declare function toMinValue<TInput$1 extends ValueInput, const TRequirement extends TInput$1>(requirement: TRequirement): ToMinValueAction<TInput$1, TRequirement>;
//#endregion
//#region src/actions/toNumber/toNumber.d.ts
/**
* To number issue interface.
*/
interface ToNumberIssue<TInput$1> extends BaseIssue<TInput$1 | number> {
  /**
  * The issue kind.
  */
  readonly kind: "transformation";
  /**
  * The issue type.
  */
  readonly type: "to_number";
  /**
  * The expected property.
  */
  readonly expected: null;
}
/**
* To number action interface.
*/
interface ToNumberAction<TInput$1, TMessage extends ErrorMessage<ToNumberIssue<TInput$1>> | undefined> extends BaseTransformation<TInput$1, number, ToNumberIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "to_number";
  /**
  * The action reference.
  */
  readonly reference: typeof toNumber;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a to number transformation action.
*
* @returns A to number action.
*
* @beta
*/
declare function toNumber<TInput$1>(): ToNumberAction<TInput$1, undefined>;
/**
* Creates a to number transformation action.
*
* @param message The error message.
*
* @returns A to number action.
*
* @beta
*/
declare function toNumber<TInput$1, const TMessage extends ErrorMessage<ToNumberIssue<TInput$1>> | undefined>(message: TMessage): ToNumberAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/toPascalCase/toPascalCase.d.ts
/**
* To pascal case action interface.
*
* @beta
*/
interface ToPascalCaseAction extends BaseTransformation<string, string, never> {
  /**
  * The action type.
  */
  readonly type: "to_pascal_case";
  /**
  * The action reference.
  */
  readonly reference: typeof toPascalCase;
}
/**
* Creates a to pascal case transformation action.
*
* Words are separated by `_`, `-` and ASCII whitespace, as well as by case
* and acronym boundaries.
*
* Hint: Acronym runs are normalized to lowercase (e.g. `parseURLValue` →
* `ParseUrlValue`) and digits stay attached to the preceding token (e.g.
* `item2Name` → `Item2Name`).
*
* @returns A to pascal case action.
*
* @beta
*/
declare function toPascalCase(): ToPascalCaseAction;
//#endregion
//#region src/actions/toSnakeCase/toSnakeCase.d.ts
/**
* To snake case action interface.
*
* @beta
*/
interface ToSnakeCaseAction extends BaseTransformation<string, string, never> {
  /**
  * The action type.
  */
  readonly type: "to_snake_case";
  /**
  * The action reference.
  */
  readonly reference: typeof toSnakeCase;
}
/**
* Creates a to snake case transformation action.
*
* Words are separated by `_`, `-` and ASCII whitespace, as well as by case
* and acronym boundaries.
*
* Hint: Acronym runs are normalized to lowercase (e.g. `parseURLValue` →
* `parse_url_value`) and digits stay attached to the preceding token (e.g.
* `item2Name` → `item2_name`).
*
* @returns A to snake case action.
*
* @beta
*/
declare function toSnakeCase(): ToSnakeCaseAction;
//#endregion
//#region src/actions/toString/toString.d.ts
/**
* To string issue interface.
*/
interface ToStringIssue<TInput$1> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "transformation";
  /**
  * The issue type.
  */
  readonly type: "to_string";
  /**
  * The expected property.
  */
  readonly expected: null;
}
/**
* To string action interface.
*/
interface ToStringAction<TInput$1, TMessage extends ErrorMessage<ToStringIssue<TInput$1>> | undefined> extends BaseTransformation<TInput$1, string, ToStringIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "to_string";
  /**
  * The action reference.
  */
  readonly reference: typeof toString;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a to string transformation action.
*
* @returns A to string action.
*
* @beta
*/
declare function toString<TInput$1>(): ToStringAction<TInput$1, undefined>;
/**
* Creates a to string transformation action.
*
* @param message The error message.
*
* @returns A to string action.
*
* @beta
*/
declare function toString<TInput$1, const TMessage extends ErrorMessage<ToStringIssue<TInput$1>> | undefined>(message: TMessage): ToStringAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/toUpperCase/toUpperCase.d.ts
/**
* To upper case action interface.
*/
interface ToUpperCaseAction extends BaseTransformation<string, string, never> {
  /**
  * The action type.
  */
  readonly type: "to_upper_case";
  /**
  * The action reference.
  */
  readonly reference: typeof toUpperCase;
}
/**
* Creates a to upper case transformation action.
*
* @returns A to upper case action.
*/
declare function toUpperCase(): ToUpperCaseAction;
//#endregion
//#region src/actions/transform/transform.d.ts
/**
* Transform action interface.
*/
interface TransformAction<TInput$1, TOutput$1> extends BaseTransformation<TInput$1, TOutput$1, never> {
  /**
  * The action type.
  */
  readonly type: "transform";
  /**
  * The action reference.
  */
  readonly reference: typeof transform;
  /**
  * The transformation operation.
  */
  readonly operation: (input: TInput$1) => TOutput$1;
}
/**
* Creates a custom transformation action.
*
* @param operation The transformation operation.
*
* @returns A transform action.
*/
declare function transform<TInput$1, TOutput$1>(operation: (input: TInput$1) => TOutput$1): TransformAction<TInput$1, TOutput$1>;
//#endregion
//#region src/actions/transform/transformAsync.d.ts
/**
* Transform action async interface.
*/
interface TransformActionAsync<TInput$1, TOutput$1> extends BaseTransformationAsync<TInput$1, TOutput$1, never> {
  /**
  * The action type.
  */
  readonly type: "transform";
  /**
  * The action reference.
  */
  readonly reference: typeof transformAsync;
  /**
  * The transformation operation.
  */
  readonly operation: (input: TInput$1) => Promise<TOutput$1>;
}
/**
* Creates a custom transformation action.
*
* @param operation The transformation operation.
*
* @returns A transform action.
*/
declare function transformAsync<TInput$1, TOutput$1>(operation: (input: TInput$1) => Promise<TOutput$1>): TransformActionAsync<TInput$1, TOutput$1>;
//#endregion
//#region src/actions/trim/trim.d.ts
/**
* Trim action interface.
*/
interface TrimAction extends BaseTransformation<string, string, never> {
  /**
  * The action type.
  */
  readonly type: "trim";
  /**
  * The action reference.
  */
  readonly reference: typeof trim;
}
/**
* Creates a trim transformation action.
*
* @returns A trim action.
*/
declare function trim(): TrimAction;
//#endregion
//#region src/actions/trimEnd/trimEnd.d.ts
/**
* Trim end action interface.
*/
interface TrimEndAction extends BaseTransformation<string, string, never> {
  /**
  * The action type.
  */
  readonly type: "trim_end";
  /**
  * The action reference.
  */
  readonly reference: typeof trimEnd;
}
/**
* Creates a trim end transformation action.
*
* @returns A trim end action.
*/
declare function trimEnd(): TrimEndAction;
//#endregion
//#region src/actions/trimStart/trimStart.d.ts
/**
* Trim start action interface.
*/
interface TrimStartAction extends BaseTransformation<string, string, never> {
  /**
  * The action type.
  */
  readonly type: "trim_start";
  /**
  * The action reference.
  */
  readonly reference: typeof trimStart;
}
/**
* Creates a trim start transformation action.
*
* @returns A trim start action.
*/
declare function trimStart(): TrimStartAction;
//#endregion
//#region src/actions/ulid/ulid.d.ts
/**
* ULID issue interface.
*/
interface UlidIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "ulid";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The ULID regex.
  */
  readonly requirement: RegExp;
}
/**
* ULID action interface.
*/
interface UlidAction<TInput$1 extends string, TMessage extends ErrorMessage<UlidIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, UlidIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "ulid";
  /**
  * The action reference.
  */
  readonly reference: typeof ulid;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The ULID regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [ULID](https://github.com/ulid/spec) validation action.
*
* @returns An ULID action.
*/
declare function ulid<TInput$1 extends string>(): UlidAction<TInput$1, undefined>;
/**
* Creates an [ULID](https://github.com/ulid/spec) validation action.
*
* @param message The error message.
*
* @returns An ULID action.
*/
declare function ulid<TInput$1 extends string, const TMessage extends ErrorMessage<UlidIssue<TInput$1>> | undefined>(message: TMessage): UlidAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/url/url.d.ts
/**
* URL issue interface.
*/
interface UrlIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "url";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The validation function.
  */
  readonly requirement: (input: string) => boolean;
}
/**
* URL action interface.
*/
interface UrlAction<TInput$1 extends string, TMessage extends ErrorMessage<UrlIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, UrlIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "url";
  /**
  * The action reference.
  */
  readonly reference: typeof url;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The validation function.
  */
  readonly requirement: (input: string) => boolean;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an [URL](https://en.wikipedia.org/wiki/URL) validation action.
*
* Hint: The value is checked with the [URL parser](https://developer.mozilla.org/en-US/docs/Web/API/URL/URL).
* This check is not perfect. For example, values like "abc:1234" are accepted.
*
* @returns An URL action.
*/
declare function url<TInput$1 extends string>(): UrlAction<TInput$1, undefined>;
/**
* Creates an [URL](https://en.wikipedia.org/wiki/URL) validation action.
*
* Hint: The value is checked with the [URL parser](https://developer.mozilla.org/en-US/docs/Web/API/URL/URL).
* This check is not perfect. For example, values like "abc:1234" are accepted.
*
* @param message The error message.
*
* @returns An URL action.
*/
declare function url<TInput$1 extends string, const TMessage extends ErrorMessage<UrlIssue<TInput$1>> | undefined>(message: TMessage): UrlAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/uuid/uuid.d.ts
/**
* UUID issue interface.
*/
interface UuidIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "uuid";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The UUID regex.
  */
  readonly requirement: RegExp;
}
/**
* UUID action interface.
*/
interface UuidAction<TInput$1 extends string, TMessage extends ErrorMessage<UuidIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, UuidIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "uuid";
  /**
  * The action reference.
  */
  readonly reference: typeof uuid;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The UUID regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
export { checkItemsAsync, CodePointsIssue, CodePointsAction, codePoints, CreditCardIssue, CreditCardAction, creditCard, Cuid2Issue, Cuid2Action, cuid2, DecimalIssue, DecimalAction, decimal, DescriptionAction, description, DigitsIssue, DigitsAction, digits, DomainIssue, DomainAction, domain, EmailIssue, EmailAction, email, EmojiIssue, EmojiAction, emoji, EmptyIssue, EmptyAction, empty, EndsWithIssue, EndsWithAction, endsWith, EntriesIssue, EntriesAction, entries, EveryItemIssue, EveryItemAction, everyItem, ExamplesAction, examples, ExcludesIssue, ExcludesAction, excludes, FilterItemsAction, filterItems, ArrayRequirement$1, FindItemAction, findItem, FiniteIssue, FiniteAction, finite, FlavorSymbol, FlavorName, Flavor, FlavorAction, flavor, GraphemesIssue, GraphemesAction, graphemes, GtValueIssue, GtValueAction, gtValue, GuardFunction, InferGuardOutput, GuardIssue, GuardAction, guard, HASH_LENGTHS, HashType, HashIssue, HashAction, hash, HexadecimalIssue, HexadecimalAction, hexadecimal, HexColorIssue, HexColorAction, hexColor, ImeiIssue, ImeiAction, imei, IncludesIssue, IncludesAction, includes, IntegerIssue, IntegerAction, integer, IpIssue, IpAction, ip, Ipv4Issue, Ipv4Action, ipv4, Ipv6Issue, Ipv6Action, ipv6, IsbnIssue, IsbnAction, isbn, IsrcIssue, IsrcAction, isrc, IsoDateIssue, IsoDateAction, isoDate, IsoDateTimeIssue, IsoDateTimeAction, isoDateTime, IsoDateTimeSecondIssue, IsoDateTimeSecondAction, isoDateTimeSecond, IsoTimeIssue, IsoTimeAction, isoTime, IsoTimeSecondIssue, IsoTimeSecondAction, isoTimeSecond, IsoTimestampIssue, IsoTimestampAction, isoTimestamp, IsoWeekIssue, IsoWeekAction, isoWeek, JwsCompactIssue, JwsCompactAction, jwsCompact, KsuidIssue, KsuidAction, ksuid, LengthIssue, LengthAction, length, LtValueIssue, LtValueAction, ltValue, MacIssue, MacAction, mac, Mac48Issue, Mac48Action, mac48, Mac64Issue, Mac64Action, mac64, ArrayAction$2, MapItemsAction, mapItems, MaxBytesIssue, MaxBytesAction, maxBytes, MaxCodePointsIssue, MaxCodePointsAction, maxCodePoints, MaxEntriesIssue, MaxEntriesAction, maxEntries, MaxGraphemesIssue, MaxGraphemesAction, maxGraphemes, MaxLengthIssue, MaxLengthAction, maxLength, MaxSizeIssue, MaxSizeAction, maxSize, MaxValueIssue, MaxValueAction, maxValue, MaxWordsIssue, MaxWordsAction, maxWords, MetadataAction, metadata, Requirement, MimeTypeIssue, MimeTypeAction, mimeType, MinBytesIssue, MinBytesAction, minBytes, MinCodePointsIssue, MinCodePointsAction, minCodePoints, MinEntriesIssue, MinEntriesAction, minEntries, MinGraphemesIssue, MinGraphemesAction, minGraphemes, MinLengthIssue, MinLengthAction, minLength, MinSizeIssue, MinSizeAction, minSize, MinValueIssue, MinValueAction, minValue, MinWordsIssue, MinWordsAction, minWords, Input, MultipleOfIssue, MultipleOfAction, multipleOf, NanoIdIssue, NanoIDIssue, NanoIdAction, NanoIDAction, nanoid, NonEmptyIssue, NonEmptyAction, nonEmpty, NormalizeForm, NormalizeAction, normalize, NotBytesIssue, NotBytesAction, notBytes, NotCodePointsIssue, NotCodePointsAction, notCodePoints, NotEntriesIssue, NotEntriesAction, notEntries, NotGraphemesIssue, NotGraphemesAction, notGraphemes, NotLengthIssue, NotLengthAction, notLength, NotSizeIssue, NotSizeAction, notSize, NotValueIssue, NotValueAction, notValue, NotValuesIssue, NotValuesAction, notValues, NotWordsIssue, NotWordsAction, notWords, OctalIssue, OctalAction, octal, ParseBooleanConfig, ParseBooleanIssue, ParseBooleanAction, parseBoolean, ParseJsonConfig, ParseJsonIssue, ParseJsonAction, parseJson, PartialInput, PartialCheckIssue, KeyOf, Path, RequiredPath, Paths, RequiredPaths, LazyPath, ValidPath, ValidPaths, DeepPick, DeepMerge, DeepPickN, PartialCheckAction, partialCheck, PartialCheckActionAsync, partialCheckAsync, RawCheckIssue, RawCheckIssueInfo, RawCheckAddIssue, RawCheckContext, RawCheckAction, rawCheck, RawCheckActionAsync, rawCheckAsync, RawTransformIssue, RawTransformIssueInfo, RawTransformAddIssue, RawTransformContext, RawTransformAction, rawTransform, RawTransformActionAsync, rawTransformAsync, ReadonlyOutput, ReadonlyAction, readonly, ArrayAction$1, ReduceItemsAction, reduceItems, RegexIssue, RegexAction, regex, ReturnsAction, returns, ReturnsActionAsync, returnsAsync, RfcEmailIssue, RfcEmailAction, rfcEmail, SafeIntegerIssue, SafeIntegerAction, safeInteger, SizeIssue, SizeAction, size, SlugIssue, SlugAction, slug, SomeItemIssue, SomeItemAction, someItem, ArrayAction, SortItemsAction, sortItems, StartsWithIssue, StartsWithAction, startsWith, StringifyJsonConfig, StringifyJsonIssue, StringifyJsonAction, stringifyJson, ToBigintIssue, ToBigintAction, toBigint, ToBooleanAction, toBoolean, ToCamelCaseAction, toCamelCase, ToDateIssue, ToDateAction, toDate, ToKebabCaseAction, toKebabCase, ToLowerCaseAction, toLowerCase, ToMaxValueAction, toMaxValue, ToMinValueAction, toMinValue, ToNumberIssue, ToNumberAction, toNumber, ToPascalCaseAction, toPascalCase, ToSnakeCaseAction, toSnakeCase, ToStringIssue, ToStringAction, toString, ToUpperCaseAction, toUpperCase, TransformAction, transform, TransformActionAsync, transformAsync, TrimAction, trim, TrimEndAction, trimEnd, TrimStartAction, trimStart, UlidIssue, UlidAction, ulid, UrlIssue, UrlAction, url, UuidIssue, UuidAction };
