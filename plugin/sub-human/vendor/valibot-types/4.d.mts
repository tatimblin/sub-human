import { assert, Cache, CacheConfig, SchemaWithCache, cache, SchemaWithCacheAsync, cacheAsync, config, Fallback, SchemaWithFallback, fallback, FallbackAsync, SchemaWithFallbackAsync, fallbackAsync, FlatErrors, flatten, KeyOf$1, Path$1, RequiredPath$1, LazyPath$1, ValidPath$1, forward, forwardAsync, SchemaWithDefault, SchemaWithDefaultAsync, InferDefault, getDefault, InferDefaults, getDefaults, getDefaultsAsync, Schema$14, getDescription, Schema$13, RecursiveConcat, InferExamples, getExamples, InferFallback, getFallback, InferFallbacks, getFallbacks, getFallbacksAsync, SchemaWithPipe, pipe, SchemaWithPipeAsync, pipeAsync, Schema$12, BasicPipeItem, RecursiveMerge$1, InferMetadata, getMetadata, TitleAction, title, Schema$11, getTitle, is, Schema$10, ForceTuple, ObjectKeys$1, keyof, message, Schema$9, SchemaWithOmit, omit, parse, parseAsync, Parser, parser, ParserAsync, parserAsync, Schema$8, PartialEntries$1, SchemaWithPartial, partial, Schema$7, PartialEntries, SchemaWithPartialAsync, partialAsync, Schema$6 } from './1.d.mts';
import { SchemaWithPick, pick, Schema$5, RequiredEntries$1, SchemaWithRequired, required, Schema$4, RequiredEntries, SchemaWithRequiredAsync, requiredAsync, SafeParseResult, safeParse, safeParseAsync, SafeParser, safeParser, SafeParserAsync, safeParserAsync, summarize, unwrap, BaseMetadata, GenericMetadata, UnknownDataset, SuccessDataset, PartialDataset, FailureDataset, OutputDataset, StandardProps, StandardResult, StandardSuccessResult, StandardFailureResult, StandardIssue, StandardPathItem, StandardTypes, BaseSchema, BaseSchemaAsync, GenericSchema, GenericSchemaAsync, BaseTransformation, BaseTransformationAsync, GenericTransformation, GenericTransformationAsync, BaseValidation, BaseValidationAsync, GenericValidation, GenericValidationAsync, InferInput, InferOutput, InferIssue, IsAny, IsNever, NonNullable$1, NonNullish, NonOptional, MaybeReadonly, DeepReadonly, MaybeDeepReadonly, MaybePromise, Prettify, MarkOptional, Merge, FirstTupleItem, LastTupleItem, UnionToIntersect, UnionToTupleHelper, UnionToTuple, ErrorMessage, Default, DefaultAsync, DefaultValue, OptionalEntrySchema, OptionalEntrySchemaAsync, ObjectEntries, ObjectEntriesAsync, ObjectKeys, InferEntriesInput, InferEntriesOutput, OptionalInputKeys, OptionalOutputKeys, InputWithQuestionMarks, OutputWithQuestionMarks, ReadonlyOutputKeys, OutputWithReadonly, InferObjectInput, InferObjectOutput, InferObjectIssue, TupleItems, TupleItemsAsync, InferTupleInput, InferTupleOutput, InferTupleIssue, ArrayPathItem, MapPathItem, ObjectPathItem, SetPathItem, UnknownPathItem, IssuePathItem, BaseIssue, GenericIssue, DotPath, ObjectPath, TupleKeys, TuplePath, IssueDotPath, Config, PipeAction, PipeActionAsync, PipeItem, PipeItemAsync, SchemaWithoutPipe, GenericPipeAction, GenericPipeActionAsync, GenericPipeItem, GenericPipeItemAsync, AnySchema, any, ArrayIssue, ArraySchema, array, ArraySchemaAsync, arrayAsync, BigintIssue, BigintSchema, bigint, BlobIssue, BlobSchema, blob, BooleanIssue, BooleanSchema, boolean, CustomIssue, Check, CustomSchema, custom, CheckAsync, CustomSchemaAsync, customAsync, DateIssue, DateSchema, date, Enum, EnumValues, EnumIssue, EnumSchema, enum_, ExactOptionalSchema, exactOptional, ExactOptionalSchemaAsync, exactOptionalAsync, FileIssue, FileSchema, file, FunctionIssue, FunctionSchema, function_, Class, InstanceIssue, InstanceSchema, instance, IntersectIssue, IntersectOptions, IntersectOptionsAsync, InferOption, InferIntersectInput, InferIntersectOutput, IntersectSchema, intersect, IntersectSchemaAsync, intersectAsync, LazySchema, lazy, LazySchemaAsync, lazyAsync, Literal, LiteralIssue, LiteralSchema, literal, LooseObjectIssue, LooseObjectSchema, looseObject, LooseObjectSchemaAsync, looseObjectAsync, LooseTupleIssue, LooseTupleSchema, looseTuple, LooseTupleSchemaAsync, looseTupleAsync, MapIssue, InferMapInput, InferMapOutput, MapSchema, map, MapSchemaAsync, mapAsync, NanIssue, NanSchema, nan, NeverIssue, NeverSchema, never, UnionIssue, UnionOptions, UnionSchema, union, UnionOptionsAsync, UnionSchemaAsync, unionAsync, NonNullableIssue, InferNonNullableInput, InferNonNullableOutput, InferNonNullableIssue, NonNullableSchema, nonNullable, NonNullableSchemaAsync, nonNullableAsync, NonNullishIssue, InferNonNullishInput, InferNonNullishOutput, InferNonNullishIssue, NonNullishSchema, nonNullish, NonNullishSchemaAsync, nonNullishAsync, NonOptionalIssue, InferNonOptionalInput, InferNonOptionalOutput, InferNonOptionalIssue, NonOptionalSchema, nonOptional, NonOptionalSchemaAsync, nonOptionalAsync, NullIssue, NullSchema, null_, InferNullableOutput, NullableSchema, nullable, NullableSchemaAsync, nullableAsync, InferNullishOutput, NullishSchema, nullish, NullishSchemaAsync, nullishAsync, NumberIssue, NumberSchema, number, ObjectIssue, ObjectSchema, object, ObjectSchemaAsync, objectAsync, ObjectWithRestIssue, ObjectWithRestSchema, objectWithRest, ObjectWithRestSchemaAsync, objectWithRestAsync, InferOptionalOutput, OptionalSchema, optional, OptionalSchemaAsync, optionalAsync, PicklistOptions, PicklistIssue, PicklistSchema, picklist, PromiseIssue, PromiseSchema, promise, RecordIssue, IsLiteral, OptionalKeys, WithQuestionMarks, WithReadonly, InferRecordInput, InferRecordOutput, RecordSchema, record, RecordSchemaAsync, recordAsync, SetIssue, InferSetInput, InferSetOutput, SetSchema, set, SetSchemaAsync, setAsync, StrictObjectIssue, StrictObjectSchema, strictObject, StrictObjectSchemaAsync, strictObjectAsync, StrictTupleIssue, StrictTupleSchema, strictTuple, StrictTupleSchemaAsync, strictTupleAsync, StringIssue, StringSchema, string, SymbolIssue, SymbolSchema, symbol, TupleIssue, TupleSchema, tuple, TupleSchemaAsync, tupleAsync, TupleWithRestIssue, TupleWithRestSchema, tupleWithRest, TupleWithRestSchemaAsync, tupleWithRestAsync, UndefinedIssue, UndefinedSchema, undefined_, InferUndefinedableOutput, UndefinedableSchema, undefinedable, UndefinedableSchemaAsync, undefinedableAsync, UnknownSchema, unknown, VariantSchema, variant, VariantSchemaAsync, variantAsync, VariantIssue, VariantOptionSchema, VariantOptionSchemaAsync, VariantObjectEntries, VariantObjectEntriesAsync, VariantOption, VariantOptionAsync, VariantOptions, VariantOptionsAsync, InferVariantIssue, VoidIssue, VoidSchema, void_, Schema$3, ArgsAction, args, Schema$2, ArgsActionAsync, argsAsync, AwaitActionAsync, awaitAsync, Base64Issue, Base64Action, base64, BicIssue, BicAction, bic, BrandSymbol, BrandName, Brand, BrandAction, brand, BytesIssue, BytesAction, bytes, CheckIssue, CheckAction, check, CheckActionAsync, checkAsync, ArrayInput, ArrayRequirement, ArrayRequirementAsync, ContentInput, ContentRequirement, EntriesInput, LengthInput, SizeInput, ValueInput, CheckItemsIssue, CheckItemsAction, checkItems, CheckItemsActionAsync } from './2.d.mts';
import { checkItemsAsync, CodePointsIssue, CodePointsAction, codePoints, CreditCardIssue, CreditCardAction, creditCard, Cuid2Issue, Cuid2Action, cuid2, DecimalIssue, DecimalAction, decimal, DescriptionAction, description, DigitsIssue, DigitsAction, digits, DomainIssue, DomainAction, domain, EmailIssue, EmailAction, email, EmojiIssue, EmojiAction, emoji, EmptyIssue, EmptyAction, empty, EndsWithIssue, EndsWithAction, endsWith, EntriesIssue, EntriesAction, entries, EveryItemIssue, EveryItemAction, everyItem, ExamplesAction, examples, ExcludesIssue, ExcludesAction, excludes, FilterItemsAction, filterItems, ArrayRequirement$1, FindItemAction, findItem, FiniteIssue, FiniteAction, finite, FlavorSymbol, FlavorName, Flavor, FlavorAction, flavor, GraphemesIssue, GraphemesAction, graphemes, GtValueIssue, GtValueAction, gtValue, GuardFunction, InferGuardOutput, GuardIssue, GuardAction, guard, HASH_LENGTHS, HashType, HashIssue, HashAction, hash, HexadecimalIssue, HexadecimalAction, hexadecimal, HexColorIssue, HexColorAction, hexColor, ImeiIssue, ImeiAction, imei, IncludesIssue, IncludesAction, includes, IntegerIssue, IntegerAction, integer, IpIssue, IpAction, ip, Ipv4Issue, Ipv4Action, ipv4, Ipv6Issue, Ipv6Action, ipv6, IsbnIssue, IsbnAction, isbn, IsrcIssue, IsrcAction, isrc, IsoDateIssue, IsoDateAction, isoDate, IsoDateTimeIssue, IsoDateTimeAction, isoDateTime, IsoDateTimeSecondIssue, IsoDateTimeSecondAction, isoDateTimeSecond, IsoTimeIssue, IsoTimeAction, isoTime, IsoTimeSecondIssue, IsoTimeSecondAction, isoTimeSecond, IsoTimestampIssue, IsoTimestampAction, isoTimestamp, IsoWeekIssue, IsoWeekAction, isoWeek, JwsCompactIssue, JwsCompactAction, jwsCompact, KsuidIssue, KsuidAction, ksuid, LengthIssue, LengthAction, length, LtValueIssue, LtValueAction, ltValue, MacIssue, MacAction, mac, Mac48Issue, Mac48Action, mac48, Mac64Issue, Mac64Action, mac64, ArrayAction$2, MapItemsAction, mapItems, MaxBytesIssue, MaxBytesAction, maxBytes, MaxCodePointsIssue, MaxCodePointsAction, maxCodePoints, MaxEntriesIssue, MaxEntriesAction, maxEntries, MaxGraphemesIssue, MaxGraphemesAction, maxGraphemes, MaxLengthIssue, MaxLengthAction, maxLength, MaxSizeIssue, MaxSizeAction, maxSize, MaxValueIssue, MaxValueAction, maxValue, MaxWordsIssue, MaxWordsAction, maxWords, MetadataAction, metadata, Requirement, MimeTypeIssue, MimeTypeAction, mimeType, MinBytesIssue, MinBytesAction, minBytes, MinCodePointsIssue, MinCodePointsAction, minCodePoints, MinEntriesIssue, MinEntriesAction, minEntries, MinGraphemesIssue, MinGraphemesAction, minGraphemes, MinLengthIssue, MinLengthAction, minLength, MinSizeIssue, MinSizeAction, minSize, MinValueIssue, MinValueAction, minValue, MinWordsIssue, MinWordsAction, minWords, Input, MultipleOfIssue, MultipleOfAction, multipleOf, NanoIdIssue, NanoIDIssue, NanoIdAction, NanoIDAction, nanoid, NonEmptyIssue, NonEmptyAction, nonEmpty, NormalizeForm, NormalizeAction, normalize, NotBytesIssue, NotBytesAction, notBytes, NotCodePointsIssue, NotCodePointsAction, notCodePoints, NotEntriesIssue, NotEntriesAction, notEntries, NotGraphemesIssue, NotGraphemesAction, notGraphemes, NotLengthIssue, NotLengthAction, notLength, NotSizeIssue, NotSizeAction, notSize, NotValueIssue, NotValueAction, notValue, NotValuesIssue, NotValuesAction, notValues, NotWordsIssue, NotWordsAction, notWords, OctalIssue, OctalAction, octal, ParseBooleanConfig, ParseBooleanIssue, ParseBooleanAction, parseBoolean, ParseJsonConfig, ParseJsonIssue, ParseJsonAction, parseJson, PartialInput, PartialCheckIssue, KeyOf, Path, RequiredPath, Paths, RequiredPaths, LazyPath, ValidPath, ValidPaths, DeepPick, DeepMerge, DeepPickN, PartialCheckAction, partialCheck, PartialCheckActionAsync, partialCheckAsync, RawCheckIssue, RawCheckIssueInfo, RawCheckAddIssue, RawCheckContext, RawCheckAction, rawCheck, RawCheckActionAsync, rawCheckAsync, RawTransformIssue, RawTransformIssueInfo, RawTransformAddIssue, RawTransformContext, RawTransformAction, rawTransform, RawTransformActionAsync, rawTransformAsync, ReadonlyOutput, ReadonlyAction, readonly, ArrayAction$1, ReduceItemsAction, reduceItems, RegexIssue, RegexAction, regex, ReturnsAction, returns, ReturnsActionAsync, returnsAsync, RfcEmailIssue, RfcEmailAction, rfcEmail, SafeIntegerIssue, SafeIntegerAction, safeInteger, SizeIssue, SizeAction, size, SlugIssue, SlugAction, slug, SomeItemIssue, SomeItemAction, someItem, ArrayAction, SortItemsAction, sortItems, StartsWithIssue, StartsWithAction, startsWith, StringifyJsonConfig, StringifyJsonIssue, StringifyJsonAction, stringifyJson, ToBigintIssue, ToBigintAction, toBigint, ToBooleanAction, toBoolean, ToCamelCaseAction, toCamelCase, ToDateIssue, ToDateAction, toDate, ToKebabCaseAction, toKebabCase, ToLowerCaseAction, toLowerCase, ToMaxValueAction, toMaxValue, ToMinValueAction, toMinValue, ToNumberIssue, ToNumberAction, toNumber, ToPascalCaseAction, toPascalCase, ToSnakeCaseAction, toSnakeCase, ToStringIssue, ToStringAction, toString, ToUpperCaseAction, toUpperCase, TransformAction, transform, TransformActionAsync, transformAsync, TrimAction, trim, TrimEndAction, trimEnd, TrimStartAction, trimStart, UlidIssue, UlidAction, ulid, UrlIssue, UrlAction, url, UuidIssue, UuidAction } from './3.d.mts';
/**
* Creates an [UUID](https://en.wikipedia.org/wiki/Universally_unique_identifier) validation action.
*
* @returns An UUID action.
*/
declare function uuid<TInput$1 extends string>(): UuidAction<TInput$1, undefined>;
/**
* Creates an [UUID](https://en.wikipedia.org/wiki/Universally_unique_identifier) validation action.
*
* @param message The error message.
*
* @returns An UUID action.
*/
declare function uuid<TInput$1 extends string, const TMessage extends ErrorMessage<UuidIssue<TInput$1>> | undefined>(message: TMessage): UuidAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/value/value.d.ts
/**
* Value issue interface.
*/
interface ValueIssue<TInput$1 extends ValueInput, TRequirement extends TInput$1> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "value";
  /**
  * The expected property.
  */
  readonly expected: string;
  /**
  * The required value.
  */
  readonly requirement: TRequirement;
}
/**
* Value action interface.
*/
interface ValueAction<TInput$1 extends ValueInput, TRequirement extends TInput$1, TMessage extends ErrorMessage<ValueIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, ValueIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "value";
  /**
  * The action reference.
  */
  readonly reference: typeof value;
  /**
  * The expected property.
  */
  readonly expects: string;
  /**
  * The required value.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a value validation action.
*
* @param requirement The required value.
*
* @returns A value action.
*/
declare function value<TInput$1 extends ValueInput, const TRequirement extends TInput$1>(requirement: TRequirement): ValueAction<TInput$1, TRequirement, undefined>;
/**
* Creates a value validation action.
*
* @param requirement The required value.
* @param message The error message.
*
* @returns A value action.
*/
declare function value<TInput$1 extends ValueInput, const TRequirement extends TInput$1, const TMessage extends ErrorMessage<ValueIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): ValueAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/values/values.d.ts
/**
* Values issue type.
*/
interface ValuesIssue<TInput$1 extends ValueInput, TRequirement extends readonly TInput$1[]> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "values";
  /**
  * The expected property.
  */
  readonly expected: string;
  /**
  * The required values.
  */
  readonly requirement: TRequirement;
}
/**
* Values action type.
*/
interface ValuesAction<TInput$1 extends ValueInput, TRequirement extends readonly TInput$1[], TMessage extends ErrorMessage<ValuesIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, ValuesIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "values";
  /**
  * The action reference.
  */
  readonly reference: typeof values;
  /**
  * The expected property.
  */
  readonly expects: string;
  /**
  * The required values.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a values validation action.
*
* @param requirement The required values.
*
* @returns A values action.
*/
declare function values<TInput$1 extends ValueInput, const TRequirement extends readonly TInput$1[]>(requirement: TRequirement): ValuesAction<TInput$1, TRequirement, undefined>;
/**
* Creates a values validation action.
*
* @param requirement The required values.
* @param message The error message.
*
* @returns A values action.
*/
declare function values<TInput$1 extends ValueInput, const TRequirement extends readonly TInput$1[], const TMessage extends ErrorMessage<ValuesIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): ValuesAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/words/words.d.ts
/**
* Words issue interface.
*/
interface WordsIssue<TInput$1 extends string, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "words";
  /**
  * The expected property.
  */
  readonly expected: `${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The required words.
  */
  readonly requirement: TRequirement;
}
/**
* Words action interface.
*/
interface WordsAction<TInput$1 extends string, TLocales extends Intl.LocalesArgument, TRequirement extends number, TMessage extends ErrorMessage<WordsIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, WordsIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "words";
  /**
  * The action reference.
  */
  readonly reference: typeof words;
  /**
  * The expected property.
  */
  readonly expects: `${TRequirement}`;
  /**
  * The locales to be used.
  */
  readonly locales: TLocales;
  /**
  * The required words.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a words validation action.
*
* @param locales The locales to be used.
* @param requirement The required words.
*
* @returns A words action.
*/
declare function words<TInput$1 extends string, const TLocales extends Intl.LocalesArgument, const TRequirement extends number>(locales: TLocales, requirement: TRequirement): WordsAction<TInput$1, TLocales, TRequirement, undefined>;
/**
* Creates a words validation action.
*
* @param locales The locales to be used.
* @param requirement The required words.
* @param message The error message.
*
* @returns A words action.
*/
declare function words<TInput$1 extends string, const TLocales extends Intl.LocalesArgument, const TRequirement extends number, const TMessage extends ErrorMessage<WordsIssue<TInput$1, TRequirement>> | undefined>(locales: TLocales, requirement: TRequirement, message: TMessage): WordsAction<TInput$1, TLocales, TRequirement, TMessage>;
//#endregion
//#region src/regex.d.ts
/**
* [Base64](https://en.wikipedia.org/wiki/Base64) regex.
*/
declare const BASE64_REGEX: RegExp;
/**
* [BIC](https://en.wikipedia.org/wiki/ISO_9362) regex.
*/
declare const BIC_REGEX: RegExp;
/**
* [Cuid2](https://github.com/paralleldrive/cuid2) regex.
*/
declare const CUID2_REGEX: RegExp;
/**
* [Decimal](https://en.wikipedia.org/wiki/Decimal) regex.
*/
declare const DECIMAL_REGEX: RegExp;
/**
* [Digits](https://en.wikipedia.org/wiki/Numerical_digit) regex.
*/
declare const DIGITS_REGEX: RegExp;
/**
* [Domain name](https://en.wikipedia.org/wiki/Domain_name) regex.
*
* Hint: We decided against the `i` flag for better JSON Schema compatibility.
* ASCII-only validation. Internationalized domain names (IDNs) are not
* supported, including Punycode-encoded labels.
*/
declare const DOMAIN_REGEX: RegExp;
/**
* [Email address](https://en.wikipedia.org/wiki/Email_address) regex.
*
* Hint: We decided against the `i` flag to avoid matching non-ASCII characters.
*/
declare const EMAIL_REGEX: RegExp;
/**
* Emoji regex from [emoji-regex-xs](https://github.com/slevithan/emoji-regex-xs) v1.0.0 (MIT license).
*
* Hint: We decided against the newer `/^\p{RGI_Emoji}+$/v` regex because it is
* not supported in older runtimes and does not match all emoji.
*/
declare const EMOJI_REGEX: RegExp;
/**
* [Hexadecimal](https://en.wikipedia.org/wiki/Hexadecimal) regex.
*
* Hint: We decided against the `i` flag for better JSON Schema compatibility.
*/
declare const HEXADECIMAL_REGEX: RegExp;
/**
* [Hex color](https://en.wikipedia.org/wiki/Web_colors#Hex_triplet) regex.
*
* Hint: We decided against the `i` flag for better JSON Schema compatibility.
*/
declare const HEX_COLOR_REGEX: RegExp;
/**
* [IMEI](https://en.wikipedia.org/wiki/International_Mobile_Equipment_Identity) regex.
*/
declare const IMEI_REGEX: RegExp;
/**
* [IPv4](https://en.wikipedia.org/wiki/IPv4) regex.
*/
declare const IPV4_REGEX: RegExp;
/**
* [IPv6](https://en.wikipedia.org/wiki/IPv6) regex.
*/
declare const IPV6_REGEX: RegExp;
/**
* [IP](https://en.wikipedia.org/wiki/IP_address) regex.
*/
declare const IP_REGEX: RegExp;
/**
* [ISO 8601](https://en.wikipedia.org/wiki/ISO_8601) date regex.
*/
declare const ISO_DATE_REGEX: RegExp;
/**
* [ISO 8601](https://en.wikipedia.org/wiki/ISO_8601) date-time regex.
*/
declare const ISO_DATE_TIME_REGEX: RegExp;
/**
* [ISO 8601](https://en.wikipedia.org/wiki/ISO_8601) date-time with seconds regex.
*/
declare const ISO_DATE_TIME_SECOND_REGEX: RegExp;
/**
* [ISO 8601](https://en.wikipedia.org/wiki/ISO_8601) time regex.
*/
declare const ISO_TIME_REGEX: RegExp;
/**
* [ISO 8601](https://en.wikipedia.org/wiki/ISO_8601) time with seconds regex.
*/
declare const ISO_TIME_SECOND_REGEX: RegExp;
/**
* [ISO 8601](https://en.wikipedia.org/wiki/ISO_8601) timestamp regex. Allows a
* space as a date/time separator and an optional space before the UTC offset.
*/
declare const ISO_TIMESTAMP_REGEX: RegExp;
/**
* [ISO 8601](https://en.wikipedia.org/wiki/ISO_8601) week regex.
*/
declare const ISO_WEEK_REGEX: RegExp;
/**
* [JWS compact serialization](https://datatracker.ietf.org/doc/html/rfc7515#section-3.1)
* regex.
*
* Hint: Empty payload and signature segments are allowed because the
* Base64URL-encoded representation of an empty octet sequence is an empty
* string.
*/
declare const JWS_COMPACT_REGEX: RegExp;
/**
* [ISRC](https://en.wikipedia.org/wiki/International_Standard_Recording_Code) regex.
*/
declare const ISRC_REGEX: RegExp;
/**
* [KSUID](https://github.com/segmentio/ksuid) regex.
*/
declare const KSUID_REGEX: RegExp;
/**
* [MAC](https://en.wikipedia.org/wiki/MAC_address) 48 bit regex.
*
* Hint: We decided against the `i` flag for better JSON Schema compatibility.
*/
declare const MAC48_REGEX: RegExp;
/**
* [MAC](https://en.wikipedia.org/wiki/MAC_address) 64 bit regex.
*
* Hint: We decided against the `i` flag for better JSON Schema compatibility.
*/
declare const MAC64_REGEX: RegExp;
/**
* [MAC](https://en.wikipedia.org/wiki/MAC_address) regex.
*
* Hint: We decided against the `i` flag for better JSON Schema compatibility.
*/
declare const MAC_REGEX: RegExp;
/**
* [Nano ID](https://github.com/ai/nanoid) regex.
*/
declare const NANO_ID_REGEX: RegExp;
/**
* [Octal](https://en.wikipedia.org/wiki/Octal) regex.
*/
declare const OCTAL_REGEX: RegExp;
/**
* [RFC 5322 email address](https://datatracker.ietf.org/doc/html/rfc5322#section-3.4.1) regex.
*
* Hint: This regex was taken from the [HTML Living Standard Specification](https://html.spec.whatwg.org/multipage/input.html#valid-e-mail-address) and does not perfectly represent RFC 5322.
*/
declare const RFC_EMAIL_REGEX: RegExp;
/**
* [Slug](https://en.wikipedia.org/wiki/Clean_URL#Slug) regex.
*/
declare const SLUG_REGEX: RegExp;
/**
* [ULID](https://github.com/ulid/spec) regex.
*
* Hint: We decided against the `i` flag for better JSON Schema compatibility.
* Hint: The first character is restricted to `[0-7]` because the 48-bit
* timestamp cannot exceed 2^48-1, making the maximum valid ULID
* `7ZZZZZZZZZZZZZZZZZZZZZZZZZ` in Crockford's Base32 encoding.
*/
declare const ULID_REGEX: RegExp;
/**
* [UUID](https://en.wikipedia.org/wiki/Universally_unique_identifier) regex.
*/
declare const UUID_REGEX: RegExp;
//#endregion
//#region src/storages/globalConfig/globalConfig.d.ts
/**
* The global config type.
*/
type GlobalConfig = Omit<Config<never>, "message">;
/**
* Sets the global configuration.
*
* @param config The configuration.
*/
declare function setGlobalConfig(config: GlobalConfig): void;
/**
* Returns the global configuration.
*
* @param config The config to merge.
*
* @returns The configuration.
*/
declare function getGlobalConfig<const TIssue extends BaseIssue<unknown>>(config?: Config<TIssue>): Config<TIssue>;
/**
* Deletes the global configuration.
*/
declare function deleteGlobalConfig(): void;
//#endregion
//#region src/storages/globalMessage/globalMessage.d.ts
/**
* Sets a global error message.
*
* @param message The error message.
* @param lang The language of the message.
*/
declare function setGlobalMessage(message: ErrorMessage<BaseIssue<unknown>>, lang?: string): void;
/**
* Returns a global error message.
*
* @param lang The language of the message.
*
* @returns The error message.
*/
declare function getGlobalMessage(lang?: string): ErrorMessage<BaseIssue<unknown>> | undefined;
/**
* Deletes a global error message.
*
* @param lang The language of the message.
*/
declare function deleteGlobalMessage(lang?: string): void;
//#endregion
//#region src/storages/schemaMessage/schemaMessage.d.ts
/**
* Sets a schema error message.
*
* @param message The error message.
* @param lang The language of the message.
*/
declare function setSchemaMessage(message: ErrorMessage<BaseIssue<unknown>>, lang?: string): void;
/**
* Returns a schema error message.
*
* @param lang The language of the message.
*
* @returns The error message.
*/
declare function getSchemaMessage(lang?: string): ErrorMessage<BaseIssue<unknown>> | undefined;
/**
* Deletes a schema error message.
*
* @param lang The language of the message.
*/
declare function deleteSchemaMessage(lang?: string): void;
//#endregion
//#region src/storages/specificMessage/specificMessage.d.ts
/**
* Reference type.
*/
type Reference = (...args: any[]) => BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> | BaseValidation<unknown, unknown, BaseIssue<unknown>> | BaseValidationAsync<unknown, unknown, BaseIssue<unknown>> | BaseTransformation<unknown, unknown, BaseIssue<unknown>> | BaseTransformationAsync<unknown, unknown, BaseIssue<unknown>>;
/**
* Sets a specific error message.
*
* @param reference The identifier reference.
* @param message The error message.
* @param lang The language of the message.
*/
declare function setSpecificMessage<const TReference extends Reference>(reference: TReference, message: ErrorMessage<InferIssue<ReturnType<TReference>>>, lang?: string): void;
/**
* Returns a specific error message.
*
* @param reference The identifier reference.
* @param lang The language of the message.
*
* @returns The error message.
*/
declare function getSpecificMessage<const TReference extends Reference>(reference: TReference, lang?: string): ErrorMessage<InferIssue<ReturnType<TReference>>> | undefined;
/**
* Deletes a specific error message.
*
* @param reference The identifier reference.
* @param lang The language of the message.
*/
declare function deleteSpecificMessage(reference: Reference, lang?: string): void;
//#endregion
//#region src/utils/_addIssue/_addIssue.d.ts
/**
* Context type.
*/
type Context = BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> | BaseValidation<any, unknown, BaseIssue<unknown>> | BaseValidationAsync<any, unknown, BaseIssue<unknown>> | BaseTransformation<any, unknown, BaseIssue<unknown>> | BaseTransformationAsync<any, unknown, BaseIssue<unknown>>;
/**
* Other interface.
*/
interface Other<TContext extends Context> {
  input?: unknown | undefined;
  expected?: string | undefined;
  received?: string | undefined;
  message?: ErrorMessage<InferIssue<TContext>> | undefined;
  path?: [IssuePathItem, ...IssuePathItem[]] | undefined;
  issues?: [BaseIssue<InferInput<TContext>>, ...BaseIssue<InferInput<TContext>>[]] | undefined;
}
/**
* Adds an issue to the dataset.
*
* @param context The issue context.
* @param label The issue label.
* @param dataset The input dataset.
* @param config The configuration.
* @param other The optional props.
*
* @internal
*/
declare function _addIssue<const TContext extends Context>(context: TContext & {
  expects?: string | null;
  requirement?: unknown;
  message?: ErrorMessage<Extract<InferIssue<TContext>, {
    type: TContext["type"];
  }>> | undefined;
}, label: string, dataset: UnknownDataset | OutputDataset<unknown, BaseIssue<unknown>>, config: Config<InferIssue<TContext>>, other?: Other<TContext>): void;
//#endregion
//#region src/utils/_cloneDataset/_cloneDataset.d.ts
/**
* Creates a shallow copy of a dataset.
*
* Hint: The `value` is copied by reference, but the `issues` array, its issues
* and their `path` arrays are cloned to avoid reusing mutable dataset state
* across multiple runs. Mutating a returned object or array value can
* therefore affect later cache hits that reuse the same cached output.
*
* @param dataset The output dataset.
*
* @returns The copied output dataset.
*/
declare function _cloneDataset<TValue$1, TIssue extends BaseIssue<unknown>>(dataset: OutputDataset<TValue$1, TIssue>): OutputDataset<TValue$1, TIssue>;
//#endregion
//#region src/utils/_formatCase/_formatCase.d.ts
/**
* Splits a string into lowercase words and rejoins them with the given
* separator and capitalization rules.
*
* Words are separated by `_`, `-` and ASCII whitespace, as well as by case
* and acronym boundaries. Whether the first or subsequent words are
* capitalized is controlled by `capFirst` and `capRest`.
*
* Hint: Implemented in a single pass that emits directly to the result
* string to avoid an intermediate `string[]` allocation. ASCII chars are
* classified via char codes to skip `.toLowerCase()` and `.toUpperCase()`
* method calls in the common case.
*
* Hint: Digits are treated as a separate character class, so `item2Name`
* yields `item2` and `name` rather than `item`, `2` and `name`.
*
* @param input The input string.
* @param separator The string inserted between words.
* @param capFirst Whether to capitalize the first word.
* @param capRest Whether to capitalize subsequent words.
*
* @returns The formatted string.
*
* @internal
*/
declare function _formatCase(input: string, separator: string, capFirst: boolean, capRest: boolean): string;
//#endregion
//#region src/utils/_getByteCount/_getByteCount.d.ts
/**
* Returns the byte count of the input.
*
* @param input The input to be measured.
*
* @returns The byte count.
*
* @internal
*/
declare function _getByteCount(input: string): number;
//#endregion
//#region src/utils/_getCodePointCount/_getCodePointCount.d.ts
/**
* Returns the code point count of the input.
*
* @param input The input to be measured.
*
* @returns The code point count.
*
* @internal
*/
declare function _getCodePointCount(input: string): number;
//#endregion
//#region src/utils/_getGraphemeCount/_getGraphemeCount.d.ts
/**
* Returns the grapheme count of the input.
*
* @param input The input to be measured.
*
* @returns The grapheme count.
*
* @internal
*/
declare function _getGraphemeCount(input: string): number;
//#endregion
//#region src/utils/_getLastMetadata/_getLastMetadata.d.ts
/**
* Metadata action type.
*/
type MetadataAction$1 = TitleAction<unknown, string> | DescriptionAction<unknown, string>;
/**
* Schema type.
*/
type Schema$1 = BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> | SchemaWithPipe<readonly [BaseSchema<unknown, unknown, BaseIssue<unknown>>, ...(PipeItem<any, unknown, BaseIssue<unknown>> | MetadataAction$1)[]]> | SchemaWithPipeAsync<readonly [(BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>), ...(PipeItem<any, unknown, BaseIssue<unknown>> | PipeItemAsync<any, unknown, BaseIssue<unknown>> | MetadataAction$1)[]]>;
/**
* Returns the last top-level value of a given metadata type from a schema
* using a breadth-first search that starts with the last item in the pipeline.
*
* @param schema The schema to search.
* @param type The metadata type.
*
* @returns The value, if any.
*
* @internal
*/
declare function _getLastMetadata(schema: Schema$1, type: "title" | "description"): string | undefined;
//#endregion
//#region src/utils/_getWordCount/_getWordCount.d.ts
/**
* Returns the word count of the input.
*
* @param locales The locales to be used.
* @param input The input to be measured.
*
* @returns The word count.
*
* @internal
*/
declare function _getWordCount(locales: Intl.LocalesArgument, input: string): number;
//#endregion
//#region src/utils/_isLuhnAlgo/_isLuhnAlgo.d.ts
/**
* Checks whether a string with numbers corresponds to the luhn algorithm.
*
* @param input The input to be checked.
*
* @returns Whether input is valid.
*
* @internal
*/
declare function _isLuhnAlgo(input: string): boolean;
//#endregion
//#region src/utils/_isSameValueZero/_isSameValueZero.d.ts
/**
* Compares two values using the SameValueZero algorithm, which treats `NaN`
* as equal to itself unlike `===`.
*
* @param value1 The first value.
* @param value2 The second value.
*
* @returns Whether the values are equal.
*
* @internal
*/
declare function _isSameValueZero(value1: unknown, value2: unknown): boolean;
//#endregion
//#region src/utils/_isValidObjectKey/_isValidObjectKey.d.ts
/**
* Disallows inherited object properties and prevents object prototype
* pollution by disallowing certain keys.
*
* @param object The object to check.
* @param key The key to check.
*
* @returns Whether the key is allowed.
*
* @internal
*/
declare function _isValidObjectKey(object: object, key: string): boolean;
//#endregion
//#region src/utils/_isValueMatch/_isValueMatch.d.ts
/**
* Checks whether a value matches a value action requirement.
*
* @param requirement The value action requirement.
* @param value The value to check.
*
* @returns Whether the value matches the requirement.
*
* @internal
*/
declare function _isValueMatch(requirement: ValueInput, value: ValueInput): boolean;
//#endregion
//#region src/utils/_joinExpects/_joinExpects.d.ts
/**
* Joins multiple `expects` values with the given separator.
*
* @param values The `expects` values.
* @param separator The separator.
*
* @returns The joined `expects` property.
*
* @internal
*/
declare function _joinExpects(values: string[], separator: "&" | "|"): string;
//#endregion
//#region src/utils/_standardSchema/_standardSchema.d.ts
/**
* Eagerly creates and attaches the Standard Schema properties of a schema.
*
* Hint: The contextual `this` type includes the standard properties that are
* attached before the schema is returned.
*
* @param schema The schema to attach standard properties to.
*
* @returns The schema with standard properties attached.
*
* @internal
*/
declare function _standardSchema<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(schema: Omit<TSchema, "~standard"> & ThisType<TSchema>): TSchema;
//#endregion
//#region src/utils/_stringify/_stringify.d.ts
/**
* Stringifies an unknown input to a literal or type string.
*
* @param input The unknown input.
*
* @returns A literal or type string.
*
* @internal
*/
declare function _stringify(input: unknown): string;
//#endregion
//#region src/utils/entriesFromList/entriesFromList.d.ts
/**
* Creates an object entries definition from a list of keys and a schema.
*
* @param list A list of keys.
* @param schema The schema of the keys.
*
* @returns The object entries.
*/
declare function entriesFromList<const TList extends readonly (string | number | symbol)[], const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(list: TList, schema: TSchema): Record<TList[number], TSchema>;
//#endregion
//#region src/utils/entriesFromObjects/entriesFromObjects.d.ts
/**
* Schema type.
*/
type Schema = LooseObjectSchema<ObjectEntries, ErrorMessage<LooseObjectIssue> | undefined> | LooseObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<LooseObjectIssue> | undefined> | ObjectSchema<ObjectEntries, ErrorMessage<ObjectIssue> | undefined> | ObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchema<ObjectEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | ObjectWithRestSchemaAsync<ObjectEntriesAsync, BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchema<ObjectEntries, ErrorMessage<StrictObjectIssue> | undefined> | StrictObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<StrictObjectIssue> | undefined>;
/**
* Recursive merge type.
*/
type RecursiveMerge<TSchemas extends readonly [Schema, ...Schema[]]> = TSchemas extends readonly [infer TFirstSchema extends Schema] ? TFirstSchema["entries"] : TSchemas extends readonly [infer TFirstSchema extends Schema, ...infer TRestSchemas extends readonly [Schema, ...Schema[]]] ? Merge<TFirstSchema["entries"], RecursiveMerge<TRestSchemas>> : never;
/**
* Merged entries types.
*/
type MergedEntries<TSchemas extends readonly [Schema, ...Schema[]]> = Prettify<RecursiveMerge<TSchemas>>;
/**
* Creates a new object entries definition from existing object schemas.
*
* @param schemas The schemas to merge the entries from.
*
* @returns The object entries from the schemas.
*/
declare function entriesFromObjects<const TSchemas extends readonly [Schema, ...Schema[]]>(schemas: TSchemas): MergedEntries<TSchemas>;
//#endregion
//#region src/utils/getDotPath/getDotPath.d.ts
/**
* Creates and returns the dot path of an issue if possible.
*
* @param issue The issue to get the dot path from.
*
* @returns The dot path or null.
*/
declare function getDotPath(issue: BaseIssue<unknown>): string | null;
/**
* Creates and returns the dot path of an issue if possible.
*
* @param issue The issue to get the dot path from.
*
* @returns The dot path or null.
*/
declare function getDotPath<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(issue: InferIssue<TSchema>): IssueDotPath<TSchema> | null;
//#endregion
//#region src/utils/isOfKind/isOfKind.d.ts
/**
* A generic type guard to check the kind of an object.
*
* @param kind The kind to check for.
* @param object The object to check.
*
* @returns Whether it matches.
*/
declare function isOfKind<const TKind extends TObject["kind"], const TObject extends {
  kind: string;
}>(kind: TKind, object: TObject): object is Extract<TObject, {
  kind: TKind;
}>;
//#endregion
//#region src/utils/isOfType/isOfType.d.ts
/**
* A generic type guard to check the type of an object.
*
* @param type The type to check for.
* @param object The object to check.
*
* @returns Whether it matches.
*/
declare function isOfType<const TType extends TObject["type"], const TObject extends {
  type: string;
}>(type: TType, object: TObject): object is Extract<TObject, {
  type: TType;
}>;
//#endregion
//#region src/utils/ValiError/ValiError.d.ts
/**
* A Valibot error with useful information.
*/
declare class ValiError<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> extends Error {
  /**
  * The error issues.
  */
  readonly issues: [InferIssue<TSchema>, ...InferIssue<TSchema>[]];
  /**
  * Creates a Valibot error with useful information.
  *
  * @param issues The error issues.
  */
  constructor(issues: [InferIssue<TSchema>, ...InferIssue<TSchema>[]]);
}
//#endregion
//#region src/utils/isValiError/isValiError.d.ts
/**
* A type guard to check if an error is a ValiError.
*
* @param error The error to check.
*
* @returns Whether its a ValiError.
*/
declare function isValiError<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(error: unknown): error is ValiError<TSchema>;
export { uuid, ValueIssue, ValueAction, value, ValuesIssue, ValuesAction, values, WordsIssue, WordsAction, words, BASE64_REGEX, BIC_REGEX, CUID2_REGEX, DECIMAL_REGEX, DIGITS_REGEX, DOMAIN_REGEX, EMAIL_REGEX, EMOJI_REGEX, HEXADECIMAL_REGEX, HEX_COLOR_REGEX, IMEI_REGEX, IPV4_REGEX, IPV6_REGEX, IP_REGEX, ISO_DATE_REGEX, ISO_DATE_TIME_REGEX, ISO_DATE_TIME_SECOND_REGEX, ISO_TIME_REGEX, ISO_TIME_SECOND_REGEX, ISO_TIMESTAMP_REGEX, ISO_WEEK_REGEX, JWS_COMPACT_REGEX, ISRC_REGEX, KSUID_REGEX, MAC48_REGEX, MAC64_REGEX, MAC_REGEX, NANO_ID_REGEX, OCTAL_REGEX, RFC_EMAIL_REGEX, SLUG_REGEX, ULID_REGEX, UUID_REGEX, GlobalConfig, setGlobalConfig, getGlobalConfig, deleteGlobalConfig, setGlobalMessage, getGlobalMessage, deleteGlobalMessage, setSchemaMessage, getSchemaMessage, deleteSchemaMessage, Reference, setSpecificMessage, getSpecificMessage, deleteSpecificMessage, Context, Other, _addIssue, _cloneDataset, _formatCase, _getByteCount, _getCodePointCount, _getGraphemeCount, MetadataAction$1, Schema$1, _getLastMetadata, _getWordCount, _isLuhnAlgo, _isSameValueZero, _isValidObjectKey, _isValueMatch, _joinExpects, _standardSchema, _stringify, entriesFromList, Schema, RecursiveMerge, MergedEntries, entriesFromObjects, getDotPath, isOfKind, isOfType, ValiError, isValiError };
