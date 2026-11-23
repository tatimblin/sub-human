import { SchemaWithPick, pick, Schema$5, RequiredEntries$1, SchemaWithRequired, required, Schema$4, RequiredEntries, SchemaWithRequiredAsync, requiredAsync, SafeParseResult, safeParse, safeParseAsync, SafeParser, safeParser, SafeParserAsync, safeParserAsync, summarize, unwrap, BaseMetadata, GenericMetadata, UnknownDataset, SuccessDataset, PartialDataset, FailureDataset, OutputDataset, StandardProps, StandardResult, StandardSuccessResult, StandardFailureResult, StandardIssue, StandardPathItem, StandardTypes, BaseSchema, BaseSchemaAsync, GenericSchema, GenericSchemaAsync, BaseTransformation, BaseTransformationAsync, GenericTransformation, GenericTransformationAsync, BaseValidation, BaseValidationAsync, GenericValidation, GenericValidationAsync, InferInput, InferOutput, InferIssue, IsAny, IsNever, NonNullable$1, NonNullish, NonOptional, MaybeReadonly, DeepReadonly, MaybeDeepReadonly, MaybePromise, Prettify, MarkOptional, Merge, FirstTupleItem, LastTupleItem, UnionToIntersect, UnionToTupleHelper, UnionToTuple, ErrorMessage, Default, DefaultAsync, DefaultValue, OptionalEntrySchema, OptionalEntrySchemaAsync, ObjectEntries, ObjectEntriesAsync, ObjectKeys, InferEntriesInput, InferEntriesOutput, OptionalInputKeys, OptionalOutputKeys, InputWithQuestionMarks, OutputWithQuestionMarks, ReadonlyOutputKeys, OutputWithReadonly, InferObjectInput, InferObjectOutput, InferObjectIssue, TupleItems, TupleItemsAsync, InferTupleInput, InferTupleOutput, InferTupleIssue, ArrayPathItem, MapPathItem, ObjectPathItem, SetPathItem, UnknownPathItem, IssuePathItem, BaseIssue, GenericIssue, DotPath, ObjectPath, TupleKeys, TuplePath, IssueDotPath, Config, PipeAction, PipeActionAsync, PipeItem, PipeItemAsync, SchemaWithoutPipe, GenericPipeAction, GenericPipeActionAsync, GenericPipeItem, GenericPipeItemAsync, AnySchema, any, ArrayIssue, ArraySchema, array, ArraySchemaAsync, arrayAsync, BigintIssue, BigintSchema, bigint, BlobIssue, BlobSchema, blob, BooleanIssue, BooleanSchema, boolean, CustomIssue, Check, CustomSchema, custom, CheckAsync, CustomSchemaAsync, customAsync, DateIssue, DateSchema, date, Enum, EnumValues, EnumIssue, EnumSchema, enum_, ExactOptionalSchema, exactOptional, ExactOptionalSchemaAsync, exactOptionalAsync, FileIssue, FileSchema, file, FunctionIssue, FunctionSchema, function_, Class, InstanceIssue, InstanceSchema, instance, IntersectIssue, IntersectOptions, IntersectOptionsAsync, InferOption, InferIntersectInput, InferIntersectOutput, IntersectSchema, intersect, IntersectSchemaAsync, intersectAsync, LazySchema, lazy, LazySchemaAsync, lazyAsync, Literal, LiteralIssue, LiteralSchema, literal, LooseObjectIssue, LooseObjectSchema, looseObject, LooseObjectSchemaAsync, looseObjectAsync, LooseTupleIssue, LooseTupleSchema, looseTuple, LooseTupleSchemaAsync, looseTupleAsync, MapIssue, InferMapInput, InferMapOutput, MapSchema, map, MapSchemaAsync, mapAsync, NanIssue, NanSchema, nan, NeverIssue, NeverSchema, never, UnionIssue, UnionOptions, UnionSchema, union, UnionOptionsAsync, UnionSchemaAsync, unionAsync, NonNullableIssue, InferNonNullableInput, InferNonNullableOutput, InferNonNullableIssue, NonNullableSchema, nonNullable, NonNullableSchemaAsync, nonNullableAsync, NonNullishIssue, InferNonNullishInput, InferNonNullishOutput, InferNonNullishIssue, NonNullishSchema, nonNullish, NonNullishSchemaAsync, nonNullishAsync, NonOptionalIssue, InferNonOptionalInput, InferNonOptionalOutput, InferNonOptionalIssue, NonOptionalSchema, nonOptional, NonOptionalSchemaAsync, nonOptionalAsync, NullIssue, NullSchema, null_, InferNullableOutput, NullableSchema, nullable, NullableSchemaAsync, nullableAsync, InferNullishOutput, NullishSchema, nullish, NullishSchemaAsync, nullishAsync, NumberIssue, NumberSchema, number, ObjectIssue, ObjectSchema, object, ObjectSchemaAsync, objectAsync, ObjectWithRestIssue, ObjectWithRestSchema, objectWithRest, ObjectWithRestSchemaAsync, objectWithRestAsync, InferOptionalOutput, OptionalSchema, optional, OptionalSchemaAsync, optionalAsync, PicklistOptions, PicklistIssue, PicklistSchema, picklist, PromiseIssue, PromiseSchema, promise, RecordIssue, IsLiteral, OptionalKeys, WithQuestionMarks, WithReadonly, InferRecordInput, InferRecordOutput, RecordSchema, record, RecordSchemaAsync, recordAsync, SetIssue, InferSetInput, InferSetOutput, SetSchema, set, SetSchemaAsync, setAsync, StrictObjectIssue, StrictObjectSchema, strictObject, StrictObjectSchemaAsync, strictObjectAsync, StrictTupleIssue, StrictTupleSchema, strictTuple, StrictTupleSchemaAsync, strictTupleAsync, StringIssue, StringSchema, string, SymbolIssue, SymbolSchema, symbol, TupleIssue, TupleSchema, tuple, TupleSchemaAsync, tupleAsync, TupleWithRestIssue, TupleWithRestSchema, tupleWithRest, TupleWithRestSchemaAsync, tupleWithRestAsync, UndefinedIssue, UndefinedSchema, undefined_, InferUndefinedableOutput, UndefinedableSchema, undefinedable, UndefinedableSchemaAsync, undefinedableAsync, UnknownSchema, unknown, VariantSchema, variant, VariantSchemaAsync, variantAsync, VariantIssue, VariantOptionSchema, VariantOptionSchemaAsync, VariantObjectEntries, VariantObjectEntriesAsync, VariantOption, VariantOptionAsync, VariantOptions, VariantOptionsAsync, InferVariantIssue, VoidIssue, VoidSchema, void_, Schema$3, ArgsAction, args, Schema$2, ArgsActionAsync, argsAsync, AwaitActionAsync, awaitAsync, Base64Issue, Base64Action, base64, BicIssue, BicAction, bic, BrandSymbol, BrandName, Brand, BrandAction, brand, BytesIssue, BytesAction, bytes, CheckIssue, CheckAction, check, CheckActionAsync, checkAsync, ArrayInput, ArrayRequirement, ArrayRequirementAsync, ContentInput, ContentRequirement, EntriesInput, LengthInput, SizeInput, ValueInput, CheckItemsIssue, CheckItemsAction, checkItems, CheckItemsActionAsync } from './2.d.mts';
import { checkItemsAsync, CodePointsIssue, CodePointsAction, codePoints, CreditCardIssue, CreditCardAction, creditCard, Cuid2Issue, Cuid2Action, cuid2, DecimalIssue, DecimalAction, decimal, DescriptionAction, description, DigitsIssue, DigitsAction, digits, DomainIssue, DomainAction, domain, EmailIssue, EmailAction, email, EmojiIssue, EmojiAction, emoji, EmptyIssue, EmptyAction, empty, EndsWithIssue, EndsWithAction, endsWith, EntriesIssue, EntriesAction, entries, EveryItemIssue, EveryItemAction, everyItem, ExamplesAction, examples, ExcludesIssue, ExcludesAction, excludes, FilterItemsAction, filterItems, ArrayRequirement$1, FindItemAction, findItem, FiniteIssue, FiniteAction, finite, FlavorSymbol, FlavorName, Flavor, FlavorAction, flavor, GraphemesIssue, GraphemesAction, graphemes, GtValueIssue, GtValueAction, gtValue, GuardFunction, InferGuardOutput, GuardIssue, GuardAction, guard, HASH_LENGTHS, HashType, HashIssue, HashAction, hash, HexadecimalIssue, HexadecimalAction, hexadecimal, HexColorIssue, HexColorAction, hexColor, ImeiIssue, ImeiAction, imei, IncludesIssue, IncludesAction, includes, IntegerIssue, IntegerAction, integer, IpIssue, IpAction, ip, Ipv4Issue, Ipv4Action, ipv4, Ipv6Issue, Ipv6Action, ipv6, IsbnIssue, IsbnAction, isbn, IsrcIssue, IsrcAction, isrc, IsoDateIssue, IsoDateAction, isoDate, IsoDateTimeIssue, IsoDateTimeAction, isoDateTime, IsoDateTimeSecondIssue, IsoDateTimeSecondAction, isoDateTimeSecond, IsoTimeIssue, IsoTimeAction, isoTime, IsoTimeSecondIssue, IsoTimeSecondAction, isoTimeSecond, IsoTimestampIssue, IsoTimestampAction, isoTimestamp, IsoWeekIssue, IsoWeekAction, isoWeek, JwsCompactIssue, JwsCompactAction, jwsCompact, KsuidIssue, KsuidAction, ksuid, LengthIssue, LengthAction, length, LtValueIssue, LtValueAction, ltValue, MacIssue, MacAction, mac, Mac48Issue, Mac48Action, mac48, Mac64Issue, Mac64Action, mac64, ArrayAction$2, MapItemsAction, mapItems, MaxBytesIssue, MaxBytesAction, maxBytes, MaxCodePointsIssue, MaxCodePointsAction, maxCodePoints, MaxEntriesIssue, MaxEntriesAction, maxEntries, MaxGraphemesIssue, MaxGraphemesAction, maxGraphemes, MaxLengthIssue, MaxLengthAction, maxLength, MaxSizeIssue, MaxSizeAction, maxSize, MaxValueIssue, MaxValueAction, maxValue, MaxWordsIssue, MaxWordsAction, maxWords, MetadataAction, metadata, Requirement, MimeTypeIssue, MimeTypeAction, mimeType, MinBytesIssue, MinBytesAction, minBytes, MinCodePointsIssue, MinCodePointsAction, minCodePoints, MinEntriesIssue, MinEntriesAction, minEntries, MinGraphemesIssue, MinGraphemesAction, minGraphemes, MinLengthIssue, MinLengthAction, minLength, MinSizeIssue, MinSizeAction, minSize, MinValueIssue, MinValueAction, minValue, MinWordsIssue, MinWordsAction, minWords, Input, MultipleOfIssue, MultipleOfAction, multipleOf, NanoIdIssue, NanoIDIssue, NanoIdAction, NanoIDAction, nanoid, NonEmptyIssue, NonEmptyAction, nonEmpty, NormalizeForm, NormalizeAction, normalize, NotBytesIssue, NotBytesAction, notBytes, NotCodePointsIssue, NotCodePointsAction, notCodePoints, NotEntriesIssue, NotEntriesAction, notEntries, NotGraphemesIssue, NotGraphemesAction, notGraphemes, NotLengthIssue, NotLengthAction, notLength, NotSizeIssue, NotSizeAction, notSize, NotValueIssue, NotValueAction, notValue, NotValuesIssue, NotValuesAction, notValues, NotWordsIssue, NotWordsAction, notWords, OctalIssue, OctalAction, octal, ParseBooleanConfig, ParseBooleanIssue, ParseBooleanAction, parseBoolean, ParseJsonConfig, ParseJsonIssue, ParseJsonAction, parseJson, PartialInput, PartialCheckIssue, KeyOf, Path, RequiredPath, Paths, RequiredPaths, LazyPath, ValidPath, ValidPaths, DeepPick, DeepMerge, DeepPickN, PartialCheckAction, partialCheck, PartialCheckActionAsync, partialCheckAsync, RawCheckIssue, RawCheckIssueInfo, RawCheckAddIssue, RawCheckContext, RawCheckAction, rawCheck, RawCheckActionAsync, rawCheckAsync, RawTransformIssue, RawTransformIssueInfo, RawTransformAddIssue, RawTransformContext, RawTransformAction, rawTransform, RawTransformActionAsync, rawTransformAsync, ReadonlyOutput, ReadonlyAction, readonly, ArrayAction$1, ReduceItemsAction, reduceItems, RegexIssue, RegexAction, regex, ReturnsAction, returns, ReturnsActionAsync, returnsAsync, RfcEmailIssue, RfcEmailAction, rfcEmail, SafeIntegerIssue, SafeIntegerAction, safeInteger, SizeIssue, SizeAction, size, SlugIssue, SlugAction, slug, SomeItemIssue, SomeItemAction, someItem, ArrayAction, SortItemsAction, sortItems, StartsWithIssue, StartsWithAction, startsWith, StringifyJsonConfig, StringifyJsonIssue, StringifyJsonAction, stringifyJson, ToBigintIssue, ToBigintAction, toBigint, ToBooleanAction, toBoolean, ToCamelCaseAction, toCamelCase, ToDateIssue, ToDateAction, toDate, ToKebabCaseAction, toKebabCase, ToLowerCaseAction, toLowerCase, ToMaxValueAction, toMaxValue, ToMinValueAction, toMinValue, ToNumberIssue, ToNumberAction, toNumber, ToPascalCaseAction, toPascalCase, ToSnakeCaseAction, toSnakeCase, ToStringIssue, ToStringAction, toString, ToUpperCaseAction, toUpperCase, TransformAction, transform, TransformActionAsync, transformAsync, TrimAction, trim, TrimEndAction, trimEnd, TrimStartAction, trimStart, UlidIssue, UlidAction, ulid, UrlIssue, UrlAction, url, UuidIssue, UuidAction } from './3.d.mts';
import { uuid, ValueIssue, ValueAction, value, ValuesIssue, ValuesAction, values, WordsIssue, WordsAction, words, BASE64_REGEX, BIC_REGEX, CUID2_REGEX, DECIMAL_REGEX, DIGITS_REGEX, DOMAIN_REGEX, EMAIL_REGEX, EMOJI_REGEX, HEXADECIMAL_REGEX, HEX_COLOR_REGEX, IMEI_REGEX, IPV4_REGEX, IPV6_REGEX, IP_REGEX, ISO_DATE_REGEX, ISO_DATE_TIME_REGEX, ISO_DATE_TIME_SECOND_REGEX, ISO_TIME_REGEX, ISO_TIME_SECOND_REGEX, ISO_TIMESTAMP_REGEX, ISO_WEEK_REGEX, JWS_COMPACT_REGEX, ISRC_REGEX, KSUID_REGEX, MAC48_REGEX, MAC64_REGEX, MAC_REGEX, NANO_ID_REGEX, OCTAL_REGEX, RFC_EMAIL_REGEX, SLUG_REGEX, ULID_REGEX, UUID_REGEX, GlobalConfig, setGlobalConfig, getGlobalConfig, deleteGlobalConfig, setGlobalMessage, getGlobalMessage, deleteGlobalMessage, setSchemaMessage, getSchemaMessage, deleteSchemaMessage, Reference, setSpecificMessage, getSpecificMessage, deleteSpecificMessage, Context, Other, _addIssue, _cloneDataset, _formatCase, _getByteCount, _getCodePointCount, _getGraphemeCount, MetadataAction$1, Schema$1, _getLastMetadata, _getWordCount, _isLuhnAlgo, _isSameValueZero, _isValidObjectKey, _isValueMatch, _joinExpects, _standardSchema, _stringify, entriesFromList, Schema, RecursiveMerge, MergedEntries, entriesFromObjects, getDotPath, isOfKind, isOfType, ValiError, isValiError } from './4.d.mts';
//#region src/methods/assert/assert.d.ts
/**
* Checks if the input matches the schema. As this is an assertion function, it
* can be used as a type guard.
*
* @param schema The schema to be used.
* @param input The input to be tested.
*/
declare function assert<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema, input: unknown): asserts input is InferInput<TSchema>;
//#endregion
//#region src/methods/cache/types.d.ts
/**
* Cache interface type.
*
* @beta
*/
interface Cache<TValue$1> {
  /**
  * Creates a cache key from input and config.
  *
  * Hint: Primitive inputs are keyed by value. Object and function inputs are
  * keyed by reference identity.
  */
  key(input: unknown, config?: Config<BaseIssue<unknown>>): string;
  /**
  * Gets a value from the cache by key.
  */
  get(key: string): TValue$1 | undefined;
  /**
  * Sets a value in the cache by key.
  */
  set(key: string, value: TValue$1): void;
  /**
  * Clears all entries from the cache.
  */
  clear(): void;
}
/**
* Cache config type.
*
* @beta
*/
interface CacheConfig {
  /**
  * The maximum number of items to cache.
  *
  * @default 1000
  */
  maxSize?: number;
  /**
  * The maximum age of a cache entry in milliseconds.
  *
  * @default Infinity
  */
  maxAge?: number;
}
//#endregion
//#region src/methods/cache/cache.d.ts
/**
* Schema with cache type.
*
* @beta
*/
type SchemaWithCache<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TCacheConfig extends CacheConfig | undefined> = TSchema & {
  /**
  * The cache config.
  */
  readonly cacheConfig: TCacheConfig;
  /**
  * The cache instance.
  */
  readonly cache: Cache<OutputDataset<InferOutput<TSchema>, InferIssue<TSchema>>>;
};
/**
* Caches the output of a schema.
*
* Hint: Primitive inputs are cached by value. Object and function inputs are
* cached by reference identity, so mutating input objects and reusing the same
* reference can return a stale cached dataset. Returned objects are also
* reused by reference, so mutating cached output can affect later cache hits.
*
* @param schema The schema to cache.
*
* @returns The cached schema.
*
* @beta
*/
declare function cache<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema): SchemaWithCache<TSchema, undefined>;
/**
* Caches the output of a schema.
*
* Hint: Primitive inputs are cached by value. Object and function inputs are
* cached by reference identity, so mutating input objects and reusing the same
* reference can return a stale cached dataset. Returned objects are also
* reused by reference, so mutating cached output can affect later cache hits.
*
* @param schema The schema to cache.
* @param config The cache config.
*
* @returns The cached schema.
*
* @beta
*/
declare function cache<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TCacheConfig extends CacheConfig | undefined>(schema: TSchema, config: TCacheConfig): SchemaWithCache<TSchema, TCacheConfig>;
//#endregion
//#region src/methods/cache/cacheAsync.d.ts
/**
* Schema with cache async type.
*
* @beta
*/
type SchemaWithCacheAsync<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TCacheConfig extends CacheConfig | undefined> = Omit<TSchema, "async" | "~standard" | "~run"> & {
  /**
  * Whether it's async.
  */
  readonly async: true;
  /**
  * The cache config.
  */
  readonly cacheConfig: TCacheConfig;
  /**
  * The cache instance.
  */
  readonly cache: Cache<OutputDataset<InferOutput<TSchema>, InferIssue<TSchema>>>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferInput<TSchema>, InferOutput<TSchema>>;
  /**
  * Parses unknown input values.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => Promise<OutputDataset<InferOutput<TSchema>, InferIssue<TSchema>>>;
};
/**
* Caches the output of a schema.
*
* Hint: Primitive inputs are cached by value. Object and function inputs are
* cached by reference identity, so mutating input objects and reusing the same
* reference can return a stale cached dataset. Returned objects are also
* reused by reference, so mutating cached output can affect later cache hits.
*
* @param schema The schema to cache.
*
* @returns The cached schema.
*
* @beta
*/
declare function cacheAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema): SchemaWithCacheAsync<TSchema, undefined>;
/**
* Caches the output of a schema.
*
* Hint: Primitive inputs are cached by value. Object and function inputs are
* cached by reference identity, so mutating input objects and reusing the same
* reference can return a stale cached dataset. Returned objects are also
* reused by reference, so mutating cached output can affect later cache hits.
*
* @param schema The schema to cache.
* @param config The cache config.
*
* @returns The cached schema.
*
* @beta
*/
declare function cacheAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TCacheConfig extends CacheConfig | undefined>(schema: TSchema, config: TCacheConfig): SchemaWithCacheAsync<TSchema, TCacheConfig>;
//#endregion
//#region src/methods/config/config.d.ts
/**
* Changes the local configuration of a schema.
*
* @param schema The schema to configure.
* @param config The parse configuration.
*
* @returns The configured schema.
*/
declare function config<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema, config: Config<InferIssue<TSchema>>): TSchema;
//#endregion
//#region src/methods/fallback/fallback.d.ts
/**
* Fallback type.
*/
type Fallback<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>> = MaybeDeepReadonly<InferOutput<TSchema>> | ((dataset?: OutputDataset<InferOutput<TSchema>, InferIssue<TSchema>>, config?: Config<InferIssue<TSchema>>) => MaybeDeepReadonly<InferOutput<TSchema>>);
/**
* Schema with fallback type.
*/
type SchemaWithFallback<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TFallback$1 extends Fallback<TSchema>> = TSchema & {
  /**
  * The fallback value.
  */
  readonly fallback: TFallback$1;
};
/**
* Returns a fallback value as output if the input does not match the schema.
*
* @param schema The schema to catch.
* @param fallback The fallback value.
*
* @returns The passed schema.
*/
declare function fallback<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TFallback$1 extends Fallback<TSchema>>(schema: TSchema, fallback: TFallback$1): SchemaWithFallback<TSchema, TFallback$1>;
//#endregion
//#region src/methods/fallback/fallbackAsync.d.ts
/**
* Fallback async type.
*/
type FallbackAsync<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = MaybeDeepReadonly<InferOutput<TSchema>> | ((dataset?: OutputDataset<InferOutput<TSchema>, InferIssue<TSchema>>, config?: Config<InferIssue<TSchema>>) => MaybePromise<MaybeDeepReadonly<InferOutput<TSchema>>>);
/**
* Schema with fallback async type.
*/
type SchemaWithFallbackAsync<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TFallback$1 extends FallbackAsync<TSchema>> = Omit<TSchema, "async" | "~standard" | "~run"> & {
  /**
  * The fallback value.
  */
  readonly fallback: TFallback$1;
  /**
  * Whether it's async.
  */
  readonly async: true;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferInput<TSchema>, InferOutput<TSchema>>;
  /**
  * Parses unknown input values.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => Promise<OutputDataset<InferOutput<TSchema>, InferIssue<TSchema>>>;
};
/**
* Returns a fallback value as output if the input does not match the schema.
*
* @param schema The schema to catch.
* @param fallback The fallback value.
*
* @returns The passed schema.
*/
declare function fallbackAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TFallback$1 extends FallbackAsync<TSchema>>(schema: TSchema, fallback: TFallback$1): SchemaWithFallbackAsync<TSchema, TFallback$1>;
//#endregion
//#region src/methods/flatten/flatten.d.ts
/**
* Flat errors type.
*/
type FlatErrors<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> | undefined> = Prettify<{
  /**
  * The root errors.
  *
  * Hint: The error messages of issues without a path that belong to the root
  * of the schema are added to this key.
  */
  readonly root?: [string, ...string[]];
  /**
  * The nested errors.
  *
  * Hint: The error messages of issues with a path that belong to the nested
  * parts of the schema and can be converted to a dot path are added to this
  * key.
  */
  readonly nested?: Prettify<Readonly<Partial<Record<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> ? IssueDotPath<TSchema> : string, [string, ...string[]]>>>>;
  /**
  * The other errors.
  *
  * Hint: Some issue paths, for example for complex data types like `Set` and
  * `Map`, have no key or a key that cannot be converted to a dot path. These
  * error messages are added to this key.
  */
  readonly other?: [string, ...string[]];
}>;
/**
* Flatten the error messages of issues.
*
* @param issues The list of issues.
*
* @returns A flat error object.
*/
declare function flatten(issues: readonly [BaseIssue<unknown>, ...BaseIssue<unknown>[]]): FlatErrors<undefined>;
/**
* Flatten the error messages of issues.
*
* @param issues The list of issues.
*
* @returns A flat error object.
*/
declare function flatten<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(issues: readonly [InferIssue<TSchema>, ...InferIssue<TSchema>[]]): FlatErrors<TSchema>;
//#endregion
//#region src/methods/forward/types.d.ts
/**
* Extracts the exact keys of a tuple, array or object.
*/
type KeyOf$1<TValue$1> = IsAny<TValue$1> extends true ? never : TValue$1 extends readonly unknown[] ? number extends TValue$1["length"] ? number : { [TKey in keyof TValue$1]: TKey extends `${infer TIndex extends number}` ? TIndex : never }[number] : TValue$1 extends Record<string, unknown> ? keyof TValue$1 & (string | number) : never;
/**
* Path type.
*/
type Path$1 = readonly (string | number)[];
/**
* Required path type.
*/
type RequiredPath$1 = readonly [string | number, ...Path$1];
/**
* Lazily evaluate only the first valid path segment based on the given value.
*/
type LazyPath$1<TValue$1, TPathToCheck extends Path$1, TValidPath extends Path$1 = readonly []> = TPathToCheck extends readonly [] ? TValidPath : TPathToCheck extends readonly [infer TFirstKey extends KeyOf$1<TValue$1> & keyof TValue$1, ...infer TPathRest extends Path$1] ? LazyPath$1<TValue$1[TFirstKey], TPathRest, readonly [...TValidPath, TFirstKey]> : IsNever<KeyOf$1<TValue$1>> extends false ? readonly [...TValidPath, KeyOf$1<TValue$1>] : TValidPath;
/**
* Returns the path if valid, otherwise the first possible valid path based on
* the given value.
*/
type ValidPath$1<TValue$1 extends Record<string, unknown> | ArrayLike<unknown>, TPath extends RequiredPath$1> = TPath extends LazyPath$1<TValue$1, TPath> ? TPath : LazyPath$1<TValue$1, TPath>;
//#endregion
//#region src/methods/forward/forward.d.ts
/**
* Forwards the issues of the passed validation action.
*
* @param action The validation action.
* @param path The path to forward the issues to.
*
* @returns The modified action.
*/
declare function forward<TInput$1 extends Record<string, unknown> | ArrayLike<unknown>, TIssue extends BaseIssue<unknown>, const TPath extends RequiredPath$1>(action: BaseValidation<TInput$1, TInput$1, TIssue>, path: ValidPath$1<TInput$1, TPath>): BaseValidation<TInput$1, TInput$1, TIssue>;
//#endregion
//#region src/methods/forward/forwardAsync.d.ts
/**
* Forwards the issues of the passed validation action.
*
* @param action The validation action.
* @param path The path to forward the issues to.
*
* @returns The modified action.
*/
declare function forwardAsync<TInput$1 extends Record<string, unknown> | ArrayLike<unknown>, TIssue extends BaseIssue<unknown>, const TPath extends RequiredPath$1>(action: BaseValidation<TInput$1, TInput$1, TIssue> | BaseValidationAsync<TInput$1, TInput$1, TIssue>, path: ValidPath$1<TInput$1, TPath>): BaseValidationAsync<TInput$1, TInput$1, TIssue>;
//#endregion
//#region src/methods/getDefault/getDefault.d.ts
/**
* Schema with default type.
*/
type SchemaWithDefault = ExactOptionalSchema<BaseSchema<unknown, unknown, BaseIssue<unknown>>, unknown> | NullableSchema<BaseSchema<unknown, unknown, BaseIssue<unknown>>, unknown> | NullishSchema<BaseSchema<unknown, unknown, BaseIssue<unknown>>, unknown> | OptionalSchema<BaseSchema<unknown, unknown, BaseIssue<unknown>>, unknown> | UndefinedableSchema<BaseSchema<unknown, unknown, BaseIssue<unknown>>, unknown>;
/**
* Schema with default async type.
*/
type SchemaWithDefaultAsync = ExactOptionalSchemaAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, unknown> | NullableSchemaAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, unknown> | NullishSchemaAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, unknown> | OptionalSchemaAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, unknown> | UndefinedableSchemaAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, unknown>;
/**
* Infer default type.
*/
type InferDefault<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> | SchemaWithDefault | SchemaWithDefaultAsync> = TSchema extends SchemaWithDefault | SchemaWithDefaultAsync ? TSchema["default"] extends ((...args: any) => any) ? ReturnType<TSchema["default"]> : TSchema["default"] : undefined;
/**
* Returns the default value of the schema.
*
* @param schema The schema to get it from.
* @param dataset The input dataset if available.
* @param config The config if available.
*
* @returns The default value.
*/
declare function getDefault<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema, dataset?: UnknownDataset, config?: Config<InferIssue<TSchema>>): InferDefault<TSchema>;
//#endregion
//#region src/methods/getDefaults/types.d.ts
/**
* Infer defaults type.
*/
type InferDefaults<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = TSchema extends LooseObjectSchema<infer TEntries, ErrorMessage<LooseObjectIssue> | undefined> | ObjectSchema<infer TEntries, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchema<infer TEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchema<infer TEntries, ErrorMessage<StrictObjectIssue> | undefined> ? { -readonly [TKey in keyof TEntries]: InferDefaults<TEntries[TKey]> } : TSchema extends LooseObjectSchemaAsync<infer TEntries, ErrorMessage<LooseObjectIssue> | undefined> | ObjectSchemaAsync<infer TEntries, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchemaAsync<infer TEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchemaAsync<infer TEntries, ErrorMessage<StrictObjectIssue> | undefined> ? { -readonly [TKey in keyof TEntries]: InferDefaults<TEntries[TKey]> } : TSchema extends LooseTupleSchema<infer TItems, ErrorMessage<LooseTupleIssue> | undefined> | StrictTupleSchema<infer TItems, ErrorMessage<StrictTupleIssue> | undefined> | TupleSchema<infer TItems, ErrorMessage<TupleIssue> | undefined> | TupleWithRestSchema<infer TItems, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<TupleWithRestIssue> | undefined> ? { -readonly [TKey in keyof TItems]: InferDefaults<TItems[TKey]> } : TSchema extends LooseTupleSchemaAsync<infer TItems, ErrorMessage<LooseTupleIssue> | undefined> | StrictTupleSchemaAsync<infer TItems, ErrorMessage<StrictTupleIssue> | undefined> | TupleSchemaAsync<infer TItems, ErrorMessage<TupleIssue> | undefined> | TupleWithRestSchemaAsync<infer TItems, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<TupleWithRestIssue> | undefined> ? { -readonly [TKey in keyof TItems]: InferDefaults<TItems[TKey]> } : Awaited<InferDefault<TSchema>>;
//#endregion
//#region src/methods/getDefaults/getDefaults.d.ts
/**
* Returns the default values of the schema.
*
* Hint: The difference to `getDefault` is that for object and tuple schemas
* this function recursively returns the default values of the subschemas
* instead of `undefined`.
*
* @param schema The schema to get them from.
*
* @returns The default values.
*/
declare function getDefaults<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | LooseObjectSchema<ObjectEntries, ErrorMessage<LooseObjectIssue> | undefined> | LooseTupleSchema<TupleItems, ErrorMessage<LooseTupleIssue> | undefined> | ObjectSchema<ObjectEntries, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchema<ObjectEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchema<ObjectEntries, ErrorMessage<StrictObjectIssue> | undefined> | StrictTupleSchema<TupleItems, ErrorMessage<StrictTupleIssue> | undefined> | TupleSchema<TupleItems, ErrorMessage<TupleIssue> | undefined> | TupleWithRestSchema<TupleItems, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<TupleWithRestIssue> | undefined>>(schema: TSchema): InferDefaults<TSchema>;
//#endregion
//#region src/methods/getDefaults/getDefaultsAsync.d.ts
/**
* Returns the default values of the schema.
*
* Hint: The difference to `getDefault` is that for object and tuple schemas
* this function recursively returns the default values of the subschemas
* instead of `undefined`.
*
* @param schema The schema to get them from.
*
* @returns The default values.
*/
declare function getDefaultsAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> | LooseObjectSchema<ObjectEntries, ErrorMessage<LooseObjectIssue> | undefined> | LooseObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<LooseObjectIssue> | undefined> | LooseTupleSchema<TupleItems, ErrorMessage<LooseTupleIssue> | undefined> | LooseTupleSchemaAsync<TupleItemsAsync, ErrorMessage<LooseTupleIssue> | undefined> | ObjectSchema<ObjectEntries, ErrorMessage<ObjectIssue> | undefined> | ObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchema<ObjectEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | ObjectWithRestSchemaAsync<ObjectEntriesAsync, BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchema<ObjectEntries, ErrorMessage<StrictObjectIssue> | undefined> | StrictObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<StrictObjectIssue> | undefined> | StrictTupleSchema<TupleItems, ErrorMessage<StrictTupleIssue> | undefined> | StrictTupleSchemaAsync<TupleItemsAsync, ErrorMessage<StrictTupleIssue> | undefined> | TupleSchema<TupleItems, ErrorMessage<TupleIssue> | undefined> | TupleSchemaAsync<TupleItemsAsync, ErrorMessage<TupleIssue> | undefined> | TupleWithRestSchema<TupleItems, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<TupleWithRestIssue> | undefined> | TupleWithRestSchemaAsync<TupleItemsAsync, BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<TupleWithRestIssue> | undefined>>(schema: TSchema): Promise<InferDefaults<TSchema>>;
//#endregion
//#region src/methods/getDescription/getDescription.d.ts
/**
* Schema type.
*/
type Schema$14 = BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> | SchemaWithPipe<readonly [BaseSchema<unknown, unknown, BaseIssue<unknown>>, ...(PipeItem<any, unknown, BaseIssue<unknown>> | DescriptionAction<unknown, string>)[]]> | SchemaWithPipeAsync<readonly [(BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>), ...(PipeItem<any, unknown, BaseIssue<unknown>> | PipeItemAsync<any, unknown, BaseIssue<unknown>> | DescriptionAction<unknown, string>)[]]>;
/**
* Returns the description of the schema.
*
* If multiple descriptions are defined, the last one of the highest level is
* returned. If no description is defined, `undefined` is returned.
*
* @param schema The schema to get the description from.
*
* @returns The description, if any.
*
* @beta
*/
declare function getDescription(schema: Schema$14): string | undefined;
//#endregion
//#region src/methods/getExamples/getExamples.d.ts
/**
* Schema type.
*/
type Schema$13 = BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> | SchemaWithPipe<readonly [BaseSchema<unknown, unknown, BaseIssue<unknown>>, ...(PipeItem<any, unknown, BaseIssue<unknown>> | ExamplesAction<unknown, readonly unknown[]>)[]]> | SchemaWithPipeAsync<readonly [(BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>), ...(PipeItem<any, unknown, BaseIssue<unknown>> | PipeItemAsync<any, unknown, BaseIssue<unknown>> | ExamplesAction<unknown, readonly unknown[]>)[]]>;
/**
* Recursively concat type.
*/
type RecursiveConcat<TRootPipe extends readonly (PipeItem<any, unknown, BaseIssue<unknown>> | PipeItemAsync<any, unknown, BaseIssue<unknown>>)[], TCollectedExamples extends unknown[] = []> = TRootPipe extends readonly [infer TFirstItem, ...infer TPipeRest extends readonly (PipeItem<any, unknown, BaseIssue<unknown>> | PipeItemAsync<any, unknown, BaseIssue<unknown>>)[]] ? TFirstItem extends SchemaWithPipe<infer TNestedPipe> | SchemaWithPipeAsync<infer TNestedPipe> ? RecursiveConcat<TPipeRest, RecursiveConcat<TNestedPipe, TCollectedExamples>> : TFirstItem extends ExamplesAction<unknown, infer TCurrentExamples> ? RecursiveConcat<TPipeRest, [...TCollectedExamples, ...TCurrentExamples]> : RecursiveConcat<TPipeRest, TCollectedExamples> : TCollectedExamples;
/**
* Infer examples type.
*/
type InferExamples<TSchema extends Schema$13> = TSchema extends SchemaWithPipe<infer TPipe> | SchemaWithPipeAsync<infer TPipe> ? Readonly<RecursiveConcat<TPipe>> : [];
/**
* Returns the examples of a schema.
*
* If multiple examples are defined, it concatenates them using depth-first
* search. If no examples are defined, an empty array is returned.
*
* @param schema The schema to get the examples from.
*
* @returns The examples, if any.
*
* @beta
*/
declare function getExamples<const TSchema extends Schema$13>(schema: TSchema): InferExamples<TSchema>;
//#endregion
//#region src/methods/getFallback/getFallback.d.ts
/**
* Infer fallback type.
*/
type InferFallback<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = TSchema extends SchemaWithFallback<BaseSchema<unknown, unknown, BaseIssue<unknown>>, infer TFallback> | SchemaWithFallbackAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, infer TFallback> ? TFallback extends MaybeDeepReadonly<InferOutput<TSchema>> ? TFallback : TFallback extends (() => MaybePromise<MaybeDeepReadonly<InferOutput<TSchema>>>) ? ReturnType<TFallback> : never : undefined;
/**
* Returns the fallback value of the schema.
*
* @param schema The schema to get it from.
* @param dataset The output dataset if available.
* @param config The config if available.
*
* @returns The fallback value.
*/
declare function getFallback<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema, dataset?: OutputDataset<InferOutput<TSchema>, InferIssue<TSchema>>, config?: Config<InferIssue<TSchema>>): InferFallback<TSchema>;
//#endregion
//#region src/methods/getFallbacks/types.d.ts
/**
* Infer fallbacks type.
*/
type InferFallbacks<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = TSchema extends LooseObjectSchema<infer TEntries, ErrorMessage<LooseObjectIssue> | undefined> | ObjectSchema<infer TEntries, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchema<infer TEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchema<infer TEntries, ErrorMessage<StrictObjectIssue> | undefined> ? { -readonly [TKey in keyof TEntries]: InferFallbacks<TEntries[TKey]> } : TSchema extends LooseObjectSchemaAsync<infer TEntries, ErrorMessage<LooseObjectIssue> | undefined> | ObjectSchemaAsync<infer TEntries, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchemaAsync<infer TEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchemaAsync<infer TEntries, ErrorMessage<StrictObjectIssue> | undefined> ? { -readonly [TKey in keyof TEntries]: InferFallbacks<TEntries[TKey]> } : TSchema extends LooseTupleSchema<infer TItems, ErrorMessage<LooseTupleIssue> | undefined> | StrictTupleSchema<infer TItems, ErrorMessage<StrictTupleIssue> | undefined> | TupleSchema<infer TItems, ErrorMessage<TupleIssue> | undefined> | TupleWithRestSchema<infer TItems, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<TupleWithRestIssue> | undefined> ? { -readonly [TKey in keyof TItems]: InferFallbacks<TItems[TKey]> } : TSchema extends LooseTupleSchemaAsync<infer TItems, ErrorMessage<LooseTupleIssue> | undefined> | StrictTupleSchemaAsync<infer TItems, ErrorMessage<StrictTupleIssue> | undefined> | TupleSchemaAsync<infer TItems, ErrorMessage<TupleIssue> | undefined> | TupleWithRestSchemaAsync<infer TItems, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<TupleWithRestIssue> | undefined> ? { -readonly [TKey in keyof TItems]: InferFallbacks<TItems[TKey]> } : Awaited<InferFallback<TSchema>>;
//#endregion
//#region src/methods/getFallbacks/getFallbacks.d.ts
/**
* Returns the fallback values of the schema.
*
* Hint: The difference to `getFallback` is that for object and tuple schemas
* this function recursively returns the fallback values of the subschemas
* instead of `undefined`.
*
* @param schema The schema to get them from.
*
* @returns The fallback values.
*/
declare function getFallbacks<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | LooseObjectSchema<ObjectEntries, ErrorMessage<LooseObjectIssue> | undefined> | LooseTupleSchema<TupleItems, ErrorMessage<LooseTupleIssue> | undefined> | ObjectSchema<ObjectEntries, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchema<ObjectEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchema<ObjectEntries, ErrorMessage<StrictObjectIssue> | undefined> | StrictTupleSchema<TupleItems, ErrorMessage<StrictTupleIssue> | undefined> | TupleSchema<TupleItems, ErrorMessage<TupleIssue> | undefined> | TupleWithRestSchema<TupleItems, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<TupleWithRestIssue> | undefined>>(schema: TSchema): InferFallbacks<TSchema>;
//#endregion
//#region src/methods/getFallbacks/getFallbacksAsync.d.ts
/**
* Returns the fallback values of the schema.
*
* Hint: The difference to `getFallback` is that for object and tuple schemas
* this function recursively returns the fallback values of the subschemas
* instead of `undefined`.
*
* @param schema The schema to get them from.
*
* @returns The fallback values.
*/
declare function getFallbacksAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> | LooseObjectSchema<ObjectEntries, ErrorMessage<LooseObjectIssue> | undefined> | LooseObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<LooseObjectIssue> | undefined> | LooseTupleSchema<TupleItems, ErrorMessage<LooseTupleIssue> | undefined> | LooseTupleSchemaAsync<TupleItemsAsync, ErrorMessage<LooseTupleIssue> | undefined> | ObjectSchema<ObjectEntries, ErrorMessage<ObjectIssue> | undefined> | ObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchema<ObjectEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | ObjectWithRestSchemaAsync<ObjectEntriesAsync, BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchema<ObjectEntries, ErrorMessage<StrictObjectIssue> | undefined> | StrictObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<StrictObjectIssue> | undefined> | StrictTupleSchema<TupleItems, ErrorMessage<StrictTupleIssue> | undefined> | StrictTupleSchemaAsync<TupleItemsAsync, ErrorMessage<StrictTupleIssue> | undefined> | TupleSchema<TupleItems, ErrorMessage<TupleIssue> | undefined> | TupleSchemaAsync<TupleItemsAsync, ErrorMessage<TupleIssue> | undefined> | TupleWithRestSchema<TupleItems, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<TupleWithRestIssue> | undefined> | TupleWithRestSchemaAsync<TupleItemsAsync, BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<TupleWithRestIssue> | undefined>>(schema: TSchema): Promise<InferFallbacks<TSchema>>;
//#endregion
//#region src/methods/pipe/pipe.d.ts
/**
* Schema with pipe type.
*/
type SchemaWithPipe<TPipe$1 extends readonly [BaseSchema<unknown, unknown, BaseIssue<unknown>>, ...PipeItem<any, unknown, BaseIssue<unknown>>[]]> = Omit<FirstTupleItem<TPipe$1>, "pipe" | "~standard" | "~run" | "~types"> & {
  /**
  * The pipe items.
  */
  readonly pipe: TPipe$1;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferInput<FirstTupleItem<TPipe$1>>, InferOutput<LastTupleItem<TPipe$1>>>;
  /**
  * Parses unknown input values.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => OutputDataset<InferOutput<LastTupleItem<TPipe$1>>, InferIssue<TPipe$1[number]>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferInput<FirstTupleItem<TPipe$1>>;
    readonly output: InferOutput<LastTupleItem<TPipe$1>>;
    readonly issue: InferIssue<TPipe$1[number]>;
  } | undefined;
};
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>): SchemaWithPipe<readonly [TSchema, TItem1]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2, TItem3]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2, TItem3, TItem4]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
* @param item12 The twelfth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>>, const TItem12 extends PipeItem<InferOutput<TItem11>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>, item12: TItem12 | PipeAction<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11, TItem12]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
* @param item12 The twelfth pipe item.
* @param item13 The thirteenth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>>, const TItem12 extends PipeItem<InferOutput<TItem11>, unknown, BaseIssue<unknown>>, const TItem13 extends PipeItem<InferOutput<TItem12>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>, item12: TItem12 | PipeAction<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>>, item13: TItem13 | PipeAction<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11, TItem12, TItem13]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
* @param item12 The twelfth pipe item.
* @param item13 The thirteenth pipe item.
* @param item14 The fourteenth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>>, const TItem12 extends PipeItem<InferOutput<TItem11>, unknown, BaseIssue<unknown>>, const TItem13 extends PipeItem<InferOutput<TItem12>, unknown, BaseIssue<unknown>>, const TItem14 extends PipeItem<InferOutput<TItem13>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>, item12: TItem12 | PipeAction<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>>, item13: TItem13 | PipeAction<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>>, item14: TItem14 | PipeAction<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11, TItem12, TItem13, TItem14]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
* @param item12 The twelfth pipe item.
* @param item13 The thirteenth pipe item.
* @param item14 The fourteenth pipe item.
* @param item15 The fifteenth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>>, const TItem12 extends PipeItem<InferOutput<TItem11>, unknown, BaseIssue<unknown>>, const TItem13 extends PipeItem<InferOutput<TItem12>, unknown, BaseIssue<unknown>>, const TItem14 extends PipeItem<InferOutput<TItem13>, unknown, BaseIssue<unknown>>, const TItem15 extends PipeItem<InferOutput<TItem14>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>, item12: TItem12 | PipeAction<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>>, item13: TItem13 | PipeAction<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>>, item14: TItem14 | PipeAction<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>>, item15: TItem15 | PipeAction<InferOutput<TItem14>, InferOutput<TItem15>, InferIssue<TItem15>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11, TItem12, TItem13, TItem14, TItem15]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
* @param item12 The twelfth pipe item.
* @param item13 The thirteenth pipe item.
* @param item14 The fourteenth pipe item.
* @param item15 The fifteenth pipe item.
* @param item16 The sixteenth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>>, const TItem12 extends PipeItem<InferOutput<TItem11>, unknown, BaseIssue<unknown>>, const TItem13 extends PipeItem<InferOutput<TItem12>, unknown, BaseIssue<unknown>>, const TItem14 extends PipeItem<InferOutput<TItem13>, unknown, BaseIssue<unknown>>, const TItem15 extends PipeItem<InferOutput<TItem14>, unknown, BaseIssue<unknown>>, const TItem16 extends PipeItem<InferOutput<TItem15>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>, item12: TItem12 | PipeAction<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>>, item13: TItem13 | PipeAction<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>>, item14: TItem14 | PipeAction<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>>, item15: TItem15 | PipeAction<InferOutput<TItem14>, InferOutput<TItem15>, InferIssue<TItem15>>, item16: TItem16 | PipeAction<InferOutput<TItem15>, InferOutput<TItem16>, InferIssue<TItem16>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11, TItem12, TItem13, TItem14, TItem15, TItem16]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
* @param item12 The twelfth pipe item.
* @param item13 The thirteenth pipe item.
* @param item14 The fourteenth pipe item.
* @param item15 The fifteenth pipe item.
* @param item16 The sixteenth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>>, const TItem12 extends PipeItem<InferOutput<TItem11>, unknown, BaseIssue<unknown>>, const TItem13 extends PipeItem<InferOutput<TItem12>, unknown, BaseIssue<unknown>>, const TItem14 extends PipeItem<InferOutput<TItem13>, unknown, BaseIssue<unknown>>, const TItem15 extends PipeItem<InferOutput<TItem14>, unknown, BaseIssue<unknown>>, const TItem16 extends PipeItem<InferOutput<TItem15>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>, item12: TItem12 | PipeAction<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>>, item13: TItem13 | PipeAction<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>>, item14: TItem14 | PipeAction<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>>, item15: TItem15 | PipeAction<InferOutput<TItem14>, InferOutput<TItem15>, InferIssue<TItem15>>, item16: TItem16 | PipeAction<InferOutput<TItem15>, InferOutput<TItem16>, InferIssue<TItem16>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11, TItem12, TItem13, TItem14, TItem15, TItem16]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
* @param item12 The twelfth pipe item.
* @param item13 The thirteenth pipe item.
* @param item14 The fourteenth pipe item.
* @param item15 The fifteenth pipe item.
* @param item16 The sixteenth pipe item.
* @param item17 The seventeenth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>>, const TItem12 extends PipeItem<InferOutput<TItem11>, unknown, BaseIssue<unknown>>, const TItem13 extends PipeItem<InferOutput<TItem12>, unknown, BaseIssue<unknown>>, const TItem14 extends PipeItem<InferOutput<TItem13>, unknown, BaseIssue<unknown>>, const TItem15 extends PipeItem<InferOutput<TItem14>, unknown, BaseIssue<unknown>>, const TItem16 extends PipeItem<InferOutput<TItem15>, unknown, BaseIssue<unknown>>, const TItem17 extends PipeItem<InferOutput<TItem16>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>, item12: TItem12 | PipeAction<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>>, item13: TItem13 | PipeAction<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>>, item14: TItem14 | PipeAction<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>>, item15: TItem15 | PipeAction<InferOutput<TItem14>, InferOutput<TItem15>, InferIssue<TItem15>>, item16: TItem16 | PipeAction<InferOutput<TItem15>, InferOutput<TItem16>, InferIssue<TItem16>>, item17: TItem17 | PipeAction<InferOutput<TItem16>, InferOutput<TItem17>, InferIssue<TItem17>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11, TItem12, TItem13, TItem14, TItem15, TItem16, TItem17]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
* @param item12 The twelfth pipe item.
* @param item13 The thirteenth pipe item.
* @param item14 The fourteenth pipe item.
* @param item15 The fifteenth pipe item.
* @param item16 The sixteenth pipe item.
* @param item17 The seventeenth pipe item.
* @param item18 The eighteenth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>>, const TItem12 extends PipeItem<InferOutput<TItem11>, unknown, BaseIssue<unknown>>, const TItem13 extends PipeItem<InferOutput<TItem12>, unknown, BaseIssue<unknown>>, const TItem14 extends PipeItem<InferOutput<TItem13>, unknown, BaseIssue<unknown>>, const TItem15 extends PipeItem<InferOutput<TItem14>, unknown, BaseIssue<unknown>>, const TItem16 extends PipeItem<InferOutput<TItem15>, unknown, BaseIssue<unknown>>, const TItem17 extends PipeItem<InferOutput<TItem16>, unknown, BaseIssue<unknown>>, const TItem18 extends PipeItem<InferOutput<TItem17>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>, item12: TItem12 | PipeAction<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>>, item13: TItem13 | PipeAction<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>>, item14: TItem14 | PipeAction<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>>, item15: TItem15 | PipeAction<InferOutput<TItem14>, InferOutput<TItem15>, InferIssue<TItem15>>, item16: TItem16 | PipeAction<InferOutput<TItem15>, InferOutput<TItem16>, InferIssue<TItem16>>, item17: TItem17 | PipeAction<InferOutput<TItem16>, InferOutput<TItem17>, InferIssue<TItem17>>, item18: TItem18 | PipeAction<InferOutput<TItem17>, InferOutput<TItem18>, InferIssue<TItem18>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11, TItem12, TItem13, TItem14, TItem15, TItem16, TItem17, TItem18]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
* @param item12 The twelfth pipe item.
* @param item13 The thirteenth pipe item.
* @param item14 The fourteenth pipe item.
* @param item15 The fifteenth pipe item.
* @param item16 The sixteenth pipe item.
* @param item17 The seventeenth pipe item.
* @param item18 The eighteenth pipe item.
* @param item19 The nineteenth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>>, const TItem12 extends PipeItem<InferOutput<TItem11>, unknown, BaseIssue<unknown>>, const TItem13 extends PipeItem<InferOutput<TItem12>, unknown, BaseIssue<unknown>>, const TItem14 extends PipeItem<InferOutput<TItem13>, unknown, BaseIssue<unknown>>, const TItem15 extends PipeItem<InferOutput<TItem14>, unknown, BaseIssue<unknown>>, const TItem16 extends PipeItem<InferOutput<TItem15>, unknown, BaseIssue<unknown>>, const TItem17 extends PipeItem<InferOutput<TItem16>, unknown, BaseIssue<unknown>>, const TItem18 extends PipeItem<InferOutput<TItem17>, unknown, BaseIssue<unknown>>, const TItem19 extends PipeItem<InferOutput<TItem18>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>, item12: TItem12 | PipeAction<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>>, item13: TItem13 | PipeAction<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>>, item14: TItem14 | PipeAction<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>>, item15: TItem15 | PipeAction<InferOutput<TItem14>, InferOutput<TItem15>, InferIssue<TItem15>>, item16: TItem16 | PipeAction<InferOutput<TItem15>, InferOutput<TItem16>, InferIssue<TItem16>>, item17: TItem17 | PipeAction<InferOutput<TItem16>, InferOutput<TItem17>, InferIssue<TItem17>>, item18: TItem18 | PipeAction<InferOutput<TItem17>, InferOutput<TItem18>, InferIssue<TItem18>>, item19: TItem19 | PipeAction<InferOutput<TItem18>, InferOutput<TItem19>, InferIssue<TItem19>>): SchemaWithPipe<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11, TItem12, TItem13, TItem14, TItem15, TItem16, TItem17, TItem18, TItem19]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param items The pipe items.
*
* @returns A schema with a pipeline.
*/
declare function pipe<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TItems$1 extends readonly PipeItem<InferOutput<TSchema>, InferOutput<TSchema>, BaseIssue<unknown>>[]>(schema: TSchema, ...items: TItems$1): SchemaWithPipe<readonly [TSchema, ...TItems$1]>;
//#endregion
//#region src/methods/pipe/pipeAsync.d.ts
/**
* Schema with pipe async type.
*/
type SchemaWithPipeAsync<TPipe$1 extends readonly [(BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>), ...(PipeItem<any, unknown, BaseIssue<unknown>> | PipeItemAsync<any, unknown, BaseIssue<unknown>>)[]]> = Omit<FirstTupleItem<TPipe$1>, "async" | "pipe" | "~standard" | "~run" | "~types"> & {
  /**
  * The pipe items.
  */
  readonly pipe: TPipe$1;
  /**
  * Whether it's async.
  */
  readonly async: true;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferInput<FirstTupleItem<TPipe$1>>, InferOutput<LastTupleItem<TPipe$1>>>;
  /**
  * Parses unknown input values.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => Promise<OutputDataset<InferOutput<LastTupleItem<TPipe$1>>, InferIssue<TPipe$1[number]>>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferInput<FirstTupleItem<TPipe$1>>;
    readonly output: InferOutput<LastTupleItem<TPipe$1>>;
    readonly issue: InferIssue<TPipe$1[number]>;
  } | undefined;
};
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>): SchemaWithPipeAsync<readonly [TSchema, TItem1]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem1>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>> | PipeActionAsync<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>): SchemaWithPipeAsync<readonly [TSchema, TItem1, TItem2]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem2>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>> | PipeActionAsync<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>> | PipeActionAsync<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>): SchemaWithPipeAsync<readonly [TSchema, TItem1, TItem2, TItem3]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem3>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>> | PipeActionAsync<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>> | PipeActionAsync<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>> | PipeActionAsync<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>): SchemaWithPipeAsync<readonly [TSchema, TItem1, TItem2, TItem3, TItem4]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem4>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>> | PipeActionAsync<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>> | PipeActionAsync<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>> | PipeActionAsync<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>> | PipeActionAsync<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>): SchemaWithPipeAsync<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem5>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>> | PipeActionAsync<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>> | PipeActionAsync<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>> | PipeActionAsync<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>> | PipeActionAsync<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>> | PipeActionAsync<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>): SchemaWithPipeAsync<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem6>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>> | PipeActionAsync<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>> | PipeActionAsync<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>> | PipeActionAsync<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>> | PipeActionAsync<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>> | PipeActionAsync<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>> | PipeActionAsync<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>): SchemaWithPipeAsync<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem7>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>> | PipeActionAsync<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>> | PipeActionAsync<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>> | PipeActionAsync<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>> | PipeActionAsync<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>> | PipeActionAsync<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>> | PipeActionAsync<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>> | PipeActionAsync<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>): SchemaWithPipeAsync<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem8>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>> | PipeActionAsync<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>> | PipeActionAsync<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>> | PipeActionAsync<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>> | PipeActionAsync<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>> | PipeActionAsync<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>> | PipeActionAsync<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>> | PipeActionAsync<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>> | PipeActionAsync<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>): SchemaWithPipeAsync<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem9>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>> | PipeActionAsync<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>> | PipeActionAsync<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>> | PipeActionAsync<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>> | PipeActionAsync<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>> | PipeActionAsync<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>> | PipeActionAsync<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>> | PipeActionAsync<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>> | PipeActionAsync<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>> | PipeActionAsync<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>): SchemaWithPipeAsync<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem10>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>> | PipeActionAsync<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>> | PipeActionAsync<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>> | PipeActionAsync<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>> | PipeActionAsync<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>> | PipeActionAsync<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>> | PipeActionAsync<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>> | PipeActionAsync<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>> | PipeActionAsync<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>> | PipeActionAsync<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>> | PipeActionAsync<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>): SchemaWithPipeAsync<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
* @param item12 The twelfth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem10>, unknown, BaseIssue<unknown>>, const TItem12 extends PipeItem<InferOutput<TItem11>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem11>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>> | PipeActionAsync<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>> | PipeActionAsync<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>> | PipeActionAsync<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>> | PipeActionAsync<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>> | PipeActionAsync<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>> | PipeActionAsync<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>> | PipeActionAsync<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>> | PipeActionAsync<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>> | PipeActionAsync<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>> | PipeActionAsync<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>, item12: TItem12 | PipeAction<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>> | PipeActionAsync<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>>): SchemaWithPipeAsync<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11, TItem12]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
* @param item12 The twelfth pipe item.
* @param item13 The thirteenth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem10>, unknown, BaseIssue<unknown>>, const TItem12 extends PipeItem<InferOutput<TItem11>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem11>, unknown, BaseIssue<unknown>>, const TItem13 extends PipeItem<InferOutput<TItem12>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem12>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>> | PipeActionAsync<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>> | PipeActionAsync<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>> | PipeActionAsync<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>> | PipeActionAsync<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>> | PipeActionAsync<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>> | PipeActionAsync<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>> | PipeActionAsync<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>> | PipeActionAsync<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>> | PipeActionAsync<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>> | PipeActionAsync<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>, item12: TItem12 | PipeAction<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>> | PipeActionAsync<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>>, item13: TItem13 | PipeAction<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>> | PipeActionAsync<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>>): SchemaWithPipeAsync<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11, TItem12, TItem13]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
* @param item12 The twelfth pipe item.
* @param item13 The thirteenth pipe item.
* @param item14 The fourteenth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem10>, unknown, BaseIssue<unknown>>, const TItem12 extends PipeItem<InferOutput<TItem11>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem11>, unknown, BaseIssue<unknown>>, const TItem13 extends PipeItem<InferOutput<TItem12>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem12>, unknown, BaseIssue<unknown>>, const TItem14 extends PipeItem<InferOutput<TItem13>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem13>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>> | PipeActionAsync<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>> | PipeActionAsync<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>> | PipeActionAsync<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>> | PipeActionAsync<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>> | PipeActionAsync<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>> | PipeActionAsync<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>> | PipeActionAsync<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>> | PipeActionAsync<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>> | PipeActionAsync<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>> | PipeActionAsync<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>, item12: TItem12 | PipeAction<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>> | PipeActionAsync<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>>, item13: TItem13 | PipeAction<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>> | PipeActionAsync<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>>, item14: TItem14 | PipeAction<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>> | PipeActionAsync<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>>): SchemaWithPipeAsync<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11, TItem12, TItem13, TItem14]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
* @param item12 The twelfth pipe item.
* @param item13 The thirteenth pipe item.
* @param item14 The fourteenth pipe item.
* @param item15 The fifteenth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem10>, unknown, BaseIssue<unknown>>, const TItem12 extends PipeItem<InferOutput<TItem11>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem11>, unknown, BaseIssue<unknown>>, const TItem13 extends PipeItem<InferOutput<TItem12>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem12>, unknown, BaseIssue<unknown>>, const TItem14 extends PipeItem<InferOutput<TItem13>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem13>, unknown, BaseIssue<unknown>>, const TItem15 extends PipeItem<InferOutput<TItem14>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem14>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>> | PipeActionAsync<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>> | PipeActionAsync<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>> | PipeActionAsync<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>> | PipeActionAsync<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>> | PipeActionAsync<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>> | PipeActionAsync<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>> | PipeActionAsync<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>> | PipeActionAsync<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>> | PipeActionAsync<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>> | PipeActionAsync<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>, item12: TItem12 | PipeAction<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>> | PipeActionAsync<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>>, item13: TItem13 | PipeAction<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>> | PipeActionAsync<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>>, item14: TItem14 | PipeAction<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>> | PipeActionAsync<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>>, item15: TItem15 | PipeAction<InferOutput<TItem14>, InferOutput<TItem15>, InferIssue<TItem15>> | PipeActionAsync<InferOutput<TItem14>, InferOutput<TItem15>, InferIssue<TItem15>>): SchemaWithPipeAsync<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11, TItem12, TItem13, TItem14, TItem15]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
* @param item12 The twelfth pipe item.
* @param item13 The thirteenth pipe item.
* @param item14 The fourteenth pipe item.
* @param item15 The fifteenth pipe item.
* @param item16 The sixteenth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem10>, unknown, BaseIssue<unknown>>, const TItem12 extends PipeItem<InferOutput<TItem11>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem11>, unknown, BaseIssue<unknown>>, const TItem13 extends PipeItem<InferOutput<TItem12>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem12>, unknown, BaseIssue<unknown>>, const TItem14 extends PipeItem<InferOutput<TItem13>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem13>, unknown, BaseIssue<unknown>>, const TItem15 extends PipeItem<InferOutput<TItem14>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem14>, unknown, BaseIssue<unknown>>, const TItem16 extends PipeItem<InferOutput<TItem15>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem15>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>> | PipeActionAsync<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>> | PipeActionAsync<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>> | PipeActionAsync<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>> | PipeActionAsync<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>> | PipeActionAsync<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>> | PipeActionAsync<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>> | PipeActionAsync<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>> | PipeActionAsync<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>> | PipeActionAsync<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>> | PipeActionAsync<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>, item12: TItem12 | PipeAction<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>> | PipeActionAsync<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>>, item13: TItem13 | PipeAction<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>> | PipeActionAsync<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>>, item14: TItem14 | PipeAction<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>> | PipeActionAsync<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>>, item15: TItem15 | PipeAction<InferOutput<TItem14>, InferOutput<TItem15>, InferIssue<TItem15>> | PipeActionAsync<InferOutput<TItem14>, InferOutput<TItem15>, InferIssue<TItem15>>, item16: TItem16 | PipeAction<InferOutput<TItem15>, InferOutput<TItem16>, InferIssue<TItem16>> | PipeActionAsync<InferOutput<TItem15>, InferOutput<TItem16>, InferIssue<TItem16>>): SchemaWithPipeAsync<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11, TItem12, TItem13, TItem14, TItem15, TItem16]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
* @param item12 The twelfth pipe item.
* @param item13 The thirteenth pipe item.
* @param item14 The fourteenth pipe item.
* @param item15 The fifteenth pipe item.
* @param item16 The sixteenth pipe item.
* @param item17 The seventeenth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem10>, unknown, BaseIssue<unknown>>, const TItem12 extends PipeItem<InferOutput<TItem11>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem11>, unknown, BaseIssue<unknown>>, const TItem13 extends PipeItem<InferOutput<TItem12>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem12>, unknown, BaseIssue<unknown>>, const TItem14 extends PipeItem<InferOutput<TItem13>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem13>, unknown, BaseIssue<unknown>>, const TItem15 extends PipeItem<InferOutput<TItem14>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem14>, unknown, BaseIssue<unknown>>, const TItem16 extends PipeItem<InferOutput<TItem15>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem15>, unknown, BaseIssue<unknown>>, const TItem17 extends PipeItem<InferOutput<TItem16>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem16>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>> | PipeActionAsync<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>> | PipeActionAsync<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>> | PipeActionAsync<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>> | PipeActionAsync<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>> | PipeActionAsync<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>> | PipeActionAsync<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>> | PipeActionAsync<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>> | PipeActionAsync<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>> | PipeActionAsync<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>> | PipeActionAsync<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>, item12: TItem12 | PipeAction<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>> | PipeActionAsync<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>>, item13: TItem13 | PipeAction<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>> | PipeActionAsync<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>>, item14: TItem14 | PipeAction<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>> | PipeActionAsync<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>>, item15: TItem15 | PipeAction<InferOutput<TItem14>, InferOutput<TItem15>, InferIssue<TItem15>> | PipeActionAsync<InferOutput<TItem14>, InferOutput<TItem15>, InferIssue<TItem15>>, item16: TItem16 | PipeAction<InferOutput<TItem15>, InferOutput<TItem16>, InferIssue<TItem16>> | PipeActionAsync<InferOutput<TItem15>, InferOutput<TItem16>, InferIssue<TItem16>>, item17: TItem17 | PipeAction<InferOutput<TItem16>, InferOutput<TItem17>, InferIssue<TItem17>> | PipeActionAsync<InferOutput<TItem16>, InferOutput<TItem17>, InferIssue<TItem17>>): SchemaWithPipeAsync<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11, TItem12, TItem13, TItem14, TItem15, TItem16, TItem17]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
* @param item12 The twelfth pipe item.
* @param item13 The thirteenth pipe item.
* @param item14 The fourteenth pipe item.
* @param item15 The fifteenth pipe item.
* @param item16 The sixteenth pipe item.
* @param item17 The seventeenth pipe item.
* @param item18 The eighteenth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem10>, unknown, BaseIssue<unknown>>, const TItem12 extends PipeItem<InferOutput<TItem11>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem11>, unknown, BaseIssue<unknown>>, const TItem13 extends PipeItem<InferOutput<TItem12>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem12>, unknown, BaseIssue<unknown>>, const TItem14 extends PipeItem<InferOutput<TItem13>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem13>, unknown, BaseIssue<unknown>>, const TItem15 extends PipeItem<InferOutput<TItem14>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem14>, unknown, BaseIssue<unknown>>, const TItem16 extends PipeItem<InferOutput<TItem15>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem15>, unknown, BaseIssue<unknown>>, const TItem17 extends PipeItem<InferOutput<TItem16>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem16>, unknown, BaseIssue<unknown>>, const TItem18 extends PipeItem<InferOutput<TItem17>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem17>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>> | PipeActionAsync<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>> | PipeActionAsync<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>> | PipeActionAsync<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>> | PipeActionAsync<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>> | PipeActionAsync<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>> | PipeActionAsync<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>> | PipeActionAsync<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>> | PipeActionAsync<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>> | PipeActionAsync<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>> | PipeActionAsync<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>, item12: TItem12 | PipeAction<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>> | PipeActionAsync<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>>, item13: TItem13 | PipeAction<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>> | PipeActionAsync<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>>, item14: TItem14 | PipeAction<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>> | PipeActionAsync<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>>, item15: TItem15 | PipeAction<InferOutput<TItem14>, InferOutput<TItem15>, InferIssue<TItem15>> | PipeActionAsync<InferOutput<TItem14>, InferOutput<TItem15>, InferIssue<TItem15>>, item16: TItem16 | PipeAction<InferOutput<TItem15>, InferOutput<TItem16>, InferIssue<TItem16>> | PipeActionAsync<InferOutput<TItem15>, InferOutput<TItem16>, InferIssue<TItem16>>, item17: TItem17 | PipeAction<InferOutput<TItem16>, InferOutput<TItem17>, InferIssue<TItem17>> | PipeActionAsync<InferOutput<TItem16>, InferOutput<TItem17>, InferIssue<TItem17>>, item18: TItem18 | PipeAction<InferOutput<TItem17>, InferOutput<TItem18>, InferIssue<TItem18>> | PipeActionAsync<InferOutput<TItem17>, InferOutput<TItem18>, InferIssue<TItem18>>): SchemaWithPipeAsync<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11, TItem12, TItem13, TItem14, TItem15, TItem16, TItem17, TItem18]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param item1 The first pipe item.
* @param item2 The second pipe item.
* @param item3 The third pipe item.
* @param item4 The fourth pipe item.
* @param item5 The fifth pipe item.
* @param item6 The sixth pipe item.
* @param item7 The seventh pipe item.
* @param item8 The eighth pipe item.
* @param item9 The ninth pipe item.
* @param item10 The tenth pipe item.
* @param item11 The eleventh pipe item.
* @param item12 The twelfth pipe item.
* @param item13 The thirteenth pipe item.
* @param item14 The fourteenth pipe item.
* @param item15 The fifteenth pipe item.
* @param item16 The sixteenth pipe item.
* @param item17 The seventeenth pipe item.
* @param item18 The eighteenth pipe item.
* @param item19 The nineteenth pipe item.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItem1 extends PipeItem<InferOutput<TSchema>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, unknown, BaseIssue<unknown>>, const TItem2 extends PipeItem<InferOutput<TItem1>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem1>, unknown, BaseIssue<unknown>>, const TItem3 extends PipeItem<InferOutput<TItem2>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem2>, unknown, BaseIssue<unknown>>, const TItem4 extends PipeItem<InferOutput<TItem3>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem3>, unknown, BaseIssue<unknown>>, const TItem5 extends PipeItem<InferOutput<TItem4>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem4>, unknown, BaseIssue<unknown>>, const TItem6 extends PipeItem<InferOutput<TItem5>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem5>, unknown, BaseIssue<unknown>>, const TItem7 extends PipeItem<InferOutput<TItem6>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem6>, unknown, BaseIssue<unknown>>, const TItem8 extends PipeItem<InferOutput<TItem7>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem7>, unknown, BaseIssue<unknown>>, const TItem9 extends PipeItem<InferOutput<TItem8>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem8>, unknown, BaseIssue<unknown>>, const TItem10 extends PipeItem<InferOutput<TItem9>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem9>, unknown, BaseIssue<unknown>>, const TItem11 extends PipeItem<InferOutput<TItem10>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem10>, unknown, BaseIssue<unknown>>, const TItem12 extends PipeItem<InferOutput<TItem11>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem11>, unknown, BaseIssue<unknown>>, const TItem13 extends PipeItem<InferOutput<TItem12>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem12>, unknown, BaseIssue<unknown>>, const TItem14 extends PipeItem<InferOutput<TItem13>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem13>, unknown, BaseIssue<unknown>>, const TItem15 extends PipeItem<InferOutput<TItem14>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem14>, unknown, BaseIssue<unknown>>, const TItem16 extends PipeItem<InferOutput<TItem15>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem15>, unknown, BaseIssue<unknown>>, const TItem17 extends PipeItem<InferOutput<TItem16>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem16>, unknown, BaseIssue<unknown>>, const TItem18 extends PipeItem<InferOutput<TItem17>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem17>, unknown, BaseIssue<unknown>>, const TItem19 extends PipeItem<InferOutput<TItem18>, unknown, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TItem18>, unknown, BaseIssue<unknown>>>(schema: TSchema, item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>> | PipeActionAsync<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>, item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>> | PipeActionAsync<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>, item3: TItem3 | PipeAction<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>> | PipeActionAsync<InferOutput<TItem2>, InferOutput<TItem3>, InferIssue<TItem3>>, item4: TItem4 | PipeAction<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>> | PipeActionAsync<InferOutput<TItem3>, InferOutput<TItem4>, InferIssue<TItem4>>, item5: TItem5 | PipeAction<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>> | PipeActionAsync<InferOutput<TItem4>, InferOutput<TItem5>, InferIssue<TItem5>>, item6: TItem6 | PipeAction<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>> | PipeActionAsync<InferOutput<TItem5>, InferOutput<TItem6>, InferIssue<TItem6>>, item7: TItem7 | PipeAction<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>> | PipeActionAsync<InferOutput<TItem6>, InferOutput<TItem7>, InferIssue<TItem7>>, item8: TItem8 | PipeAction<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>> | PipeActionAsync<InferOutput<TItem7>, InferOutput<TItem8>, InferIssue<TItem8>>, item9: TItem9 | PipeAction<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>> | PipeActionAsync<InferOutput<TItem8>, InferOutput<TItem9>, InferIssue<TItem9>>, item10: TItem10 | PipeAction<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>> | PipeActionAsync<InferOutput<TItem9>, InferOutput<TItem10>, InferIssue<TItem10>>, item11: TItem11 | PipeAction<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>> | PipeActionAsync<InferOutput<TItem10>, InferOutput<TItem11>, InferIssue<TItem11>>, item12: TItem12 | PipeAction<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>> | PipeActionAsync<InferOutput<TItem11>, InferOutput<TItem12>, InferIssue<TItem12>>, item13: TItem13 | PipeAction<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>> | PipeActionAsync<InferOutput<TItem12>, InferOutput<TItem13>, InferIssue<TItem13>>, item14: TItem14 | PipeAction<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>> | PipeActionAsync<InferOutput<TItem13>, InferOutput<TItem14>, InferIssue<TItem14>>, item15: TItem15 | PipeAction<InferOutput<TItem14>, InferOutput<TItem15>, InferIssue<TItem15>> | PipeActionAsync<InferOutput<TItem14>, InferOutput<TItem15>, InferIssue<TItem15>>, item16: TItem16 | PipeAction<InferOutput<TItem15>, InferOutput<TItem16>, InferIssue<TItem16>> | PipeActionAsync<InferOutput<TItem15>, InferOutput<TItem16>, InferIssue<TItem16>>, item17: TItem17 | PipeAction<InferOutput<TItem16>, InferOutput<TItem17>, InferIssue<TItem17>> | PipeActionAsync<InferOutput<TItem16>, InferOutput<TItem17>, InferIssue<TItem17>>, item18: TItem18 | PipeAction<InferOutput<TItem17>, InferOutput<TItem18>, InferIssue<TItem18>> | PipeActionAsync<InferOutput<TItem17>, InferOutput<TItem18>, InferIssue<TItem18>>, item19: TItem19 | PipeAction<InferOutput<TItem18>, InferOutput<TItem19>, InferIssue<TItem19>> | PipeActionAsync<InferOutput<TItem18>, InferOutput<TItem19>, InferIssue<TItem19>>): SchemaWithPipeAsync<readonly [TSchema, TItem1, TItem2, TItem3, TItem4, TItem5, TItem6, TItem7, TItem8, TItem9, TItem10, TItem11, TItem12, TItem13, TItem14, TItem15, TItem16, TItem17, TItem18, TItem19]>;
/**
* Adds a pipeline to a schema, that can validate and transform its input.
*
* @param schema The root schema.
* @param items The pipe items.
*
* @returns A schema with a pipeline.
*/
declare function pipeAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TItems$1 extends readonly (PipeItem<InferOutput<TSchema>, InferOutput<TSchema>, BaseIssue<unknown>> | PipeItemAsync<InferOutput<TSchema>, InferOutput<TSchema>, BaseIssue<unknown>>)[]>(schema: TSchema, ...items: TItems$1): SchemaWithPipeAsync<readonly [TSchema, ...TItems$1]>;
//#endregion
//#region src/methods/getMetadata/getMetadata.d.ts
/**
* Schema type.
*/
type Schema$12 = BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> | SchemaWithPipe<readonly [BaseSchema<unknown, unknown, BaseIssue<unknown>>, ...(PipeItem<any, unknown, BaseIssue<unknown>> | MetadataAction<unknown, Record<string, unknown>>)[]]> | SchemaWithPipeAsync<readonly [(BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>), ...(PipeItem<any, unknown, BaseIssue<unknown>> | PipeItemAsync<any, unknown, BaseIssue<unknown>> | MetadataAction<unknown, Record<string, unknown>>)[]]>;
/**
* Basic pipe item type.
*/
type BasicPipeItem = PipeItem<any, unknown, BaseIssue<unknown>> | PipeItemAsync<any, unknown, BaseIssue<unknown>> | MetadataAction<unknown, Record<string, unknown>>;
/**
* Recursive merge type.
*/
type RecursiveMerge$1<TRootPipe extends readonly BasicPipeItem[], TCollectedMetadata extends Record<string, unknown> = {}> = TRootPipe extends readonly [infer TFirstItem, ...infer TPipeRest extends readonly BasicPipeItem[]] ? TFirstItem extends SchemaWithPipe<infer TNestedPipe> | SchemaWithPipeAsync<infer TNestedPipe> ? RecursiveMerge$1<TPipeRest, RecursiveMerge$1<TNestedPipe, TCollectedMetadata>> : TFirstItem extends MetadataAction<unknown, infer TCurrentMetadata> ? RecursiveMerge$1<TPipeRest, Merge<TCollectedMetadata, TCurrentMetadata>> : RecursiveMerge$1<TPipeRest, TCollectedMetadata> : TCollectedMetadata;
/**
* Infer metadata type.
*
* @beta
*/
type InferMetadata<TSchema extends Schema$12> = BaseSchema<any, any, any> extends TSchema ? Record<string, unknown> : BaseSchemaAsync<any, any, any> extends TSchema ? Record<string, unknown> : TSchema extends SchemaWithPipe<infer TPipe> | SchemaWithPipeAsync<infer TPipe> ? Prettify<RecursiveMerge$1<TPipe>> : {};
/**
* Returns the metadata of a schema.
*
* If multiple metadata are defined, it shallowly merges them using depth-first
* search. If no metadata is defined, an empty object is returned.
*
* @param schema Schema to get the metadata from.
*
* @returns The metadata, if any.
*
* @beta
*/
declare function getMetadata<const TSchema extends Schema$12>(schema: TSchema): InferMetadata<TSchema>;
//#endregion
//#region src/actions/title/title.d.ts
/**
* Title action interface.
*/
interface TitleAction<TInput$1, TTitle extends string> extends BaseMetadata<TInput$1> {
  /**
  * The action type.
  */
  readonly type: "title";
  /**
  * The action reference.
  */
  readonly reference: typeof title;
  /**
  * The title text.
  */
  readonly title: TTitle;
}
/**
* Creates a title metadata action.
*
* @param title_ The title text.
*
* @returns A title action.
*/
declare function title<TInput$1, TTitle extends string>(title_: TTitle): TitleAction<TInput$1, TTitle>;
//#endregion
//#region src/methods/getTitle/getTitle.d.ts
/**
* Schema type.
*/
type Schema$11 = BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> | SchemaWithPipe<readonly [BaseSchema<unknown, unknown, BaseIssue<unknown>>, ...(PipeItem<any, unknown, BaseIssue<unknown>> | TitleAction<unknown, string>)[]]> | SchemaWithPipeAsync<readonly [(BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>), ...(PipeItem<any, unknown, BaseIssue<unknown>> | PipeItemAsync<any, unknown, BaseIssue<unknown>> | TitleAction<unknown, string>)[]]>;
/**
* Returns the title of the schema.
*
* If multiple titles are defined, the last one of the highest level is
* returned. If no title is defined, `undefined` is returned.
*
* @param schema The schema to get the title from.
*
* @returns The title, if any.
*
* @beta
*/
declare function getTitle(schema: Schema$11): string | undefined;
//#endregion
//#region src/methods/is/is.d.ts
/**
* Checks if the input matches the schema. By using a type predicate, this
* function can be used as a type guard.
*
* @param schema The schema to be used.
* @param input The input to be tested.
*
* @returns Whether the input matches the schema.
*/
declare function is<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema, input: unknown): input is InferInput<TSchema>;
//#endregion
//#region src/methods/keyof/keyof.d.ts
/**
* Schema type.
*/
type Schema$10 = LooseObjectSchema<ObjectEntries, ErrorMessage<LooseObjectIssue> | undefined> | LooseObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<LooseObjectIssue> | undefined> | ObjectSchema<ObjectEntries, ErrorMessage<ObjectIssue> | undefined> | ObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchema<ObjectEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | ObjectWithRestSchemaAsync<ObjectEntriesAsync, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchema<ObjectEntries, ErrorMessage<StrictObjectIssue> | undefined> | StrictObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<StrictObjectIssue> | undefined>;
/**
* Force tuple type.
*/
type ForceTuple<T> = T extends [string, ...string[]] ? T : [];
/**
* Object keys type.
*/
type ObjectKeys$1<TSchema extends Schema$10> = ForceTuple<UnionToTuple<keyof TSchema["entries"]>>;
/**
* Creates a picklist schema of object keys.
*
* @param schema The object schema.
*
* @returns A picklist schema.
*/
declare function keyof<const TSchema extends Schema$10>(schema: TSchema): PicklistSchema<ObjectKeys$1<TSchema>, undefined>;
/**
* Creates a picklist schema of object keys.
*
* @param schema The object schema.
* @param message The error message.
*
* @returns A picklist schema.
*/
declare function keyof<const TSchema extends Schema$10, const TMessage extends ErrorMessage<PicklistIssue> | undefined>(schema: TSchema, message: TMessage): PicklistSchema<ObjectKeys$1<TSchema>, TMessage>;
//#endregion
//#region src/methods/message/message.d.ts
/**
* Changes the local message configuration of a schema.
*
* @param schema The schema to configure.
* @param message_ The error message.
*
* @returns The configured schema.
*/
declare function message<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema, message_: ErrorMessage<InferIssue<TSchema>>): TSchema;
//#endregion
//#region src/methods/omit/omit.d.ts
/**
* Schema type.
*/
type Schema$9 = SchemaWithoutPipe<LooseObjectSchema<ObjectEntries, ErrorMessage<LooseObjectIssue> | undefined> | LooseObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<LooseObjectIssue> | undefined> | ObjectSchema<ObjectEntries, ErrorMessage<ObjectIssue> | undefined> | ObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchema<ObjectEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | ObjectWithRestSchemaAsync<ObjectEntriesAsync, BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchema<ObjectEntries, ErrorMessage<StrictObjectIssue> | undefined> | StrictObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<StrictObjectIssue> | undefined>>;
/**
* Schema with omit type.
*/
type SchemaWithOmit<TSchema extends Schema$9, TKeys extends ObjectKeys<TSchema>> = TSchema extends ObjectSchema<infer TEntries, ErrorMessage<ObjectIssue> | undefined> | StrictObjectSchema<infer TEntries, ErrorMessage<StrictObjectIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: Omit<TEntries, TKeys[number]>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<Omit<TEntries, TKeys[number]>>, InferObjectOutput<Omit<TEntries, TKeys[number]>>>;
  /**
  * Parses unknown input.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => OutputDataset<InferObjectOutput<Omit<TEntries, TKeys[number]>>, Extract<InferIssue<TSchema>, {
    type: TSchema["type"];
  }> | InferObjectIssue<Omit<TEntries, TKeys[number]>>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<Omit<TEntries, TKeys[number]>>;
    readonly output: InferObjectOutput<Omit<TEntries, TKeys[number]>>;
    readonly issue: Extract<InferIssue<TSchema>, {
      type: TSchema["type"];
    }> | InferObjectIssue<Omit<TEntries, TKeys[number]>>;
  } | undefined;
} : TSchema extends ObjectSchemaAsync<infer TEntries, ErrorMessage<ObjectIssue> | undefined> | StrictObjectSchemaAsync<infer TEntries, ErrorMessage<StrictObjectIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: Omit<TEntries, TKeys[number]>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<Omit<TEntries, TKeys[number]>>, InferObjectOutput<Omit<TEntries, TKeys[number]>>>;
  /**
  * Parses unknown input.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => Promise<OutputDataset<InferObjectOutput<Omit<TEntries, TKeys[number]>>, Extract<InferIssue<TSchema>, {
    type: TSchema["type"];
  }> | InferObjectIssue<Omit<TEntries, TKeys[number]>>>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<Omit<TEntries, TKeys[number]>>;
    readonly output: InferObjectOutput<Omit<TEntries, TKeys[number]>>;
    readonly issue: Extract<InferIssue<TSchema>, {
      type: TSchema["type"];
    }> | InferObjectIssue<Omit<TEntries, TKeys[number]>>;
  } | undefined;
} : TSchema extends LooseObjectSchema<infer TEntries, ErrorMessage<LooseObjectIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: Omit<TEntries, TKeys[number]>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<Omit<TEntries, TKeys[number]>> & {
    [key: string]: unknown;
  }, InferObjectInput<Omit<TEntries, TKeys[number]>> & {
    [key: string]: unknown;
  }>;
  /**
  * Parses unknown input.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => OutputDataset<InferObjectOutput<Omit<TEntries, TKeys[number]>> & {
    [key: string]: unknown;
  }, Extract<InferIssue<TSchema>, {
    type: TSchema["type"];
  }> | InferObjectIssue<Omit<TEntries, TKeys[number]>>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<Omit<TEntries, TKeys[number]>> & {
      [key: string]: unknown;
    };
    readonly output: InferObjectOutput<Omit<TEntries, TKeys[number]>> & {
      [key: string]: unknown;
    };
    readonly issue: Extract<InferIssue<TSchema>, {
      type: TSchema["type"];
    }> | InferObjectIssue<Omit<TEntries, TKeys[number]>>;
  } | undefined;
} : TSchema extends LooseObjectSchemaAsync<infer TEntries, ErrorMessage<LooseObjectIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: Omit<TEntries, TKeys[number]>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<Omit<TEntries, TKeys[number]>> & {
    [key: string]: unknown;
  }, InferObjectInput<Omit<TEntries, TKeys[number]>> & {
    [key: string]: unknown;
  }>;
  /**
  * Parses unknown input.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => Promise<OutputDataset<InferObjectOutput<Omit<TEntries, TKeys[number]>> & {
    [key: string]: unknown;
  }, Extract<InferIssue<TSchema>, {
    type: TSchema["type"];
  }> | InferObjectIssue<Omit<TEntries, TKeys[number]>>>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<Omit<TEntries, TKeys[number]>> & {
      [key: string]: unknown;
    };
    readonly output: InferObjectOutput<Omit<TEntries, TKeys[number]>> & {
      [key: string]: unknown;
    };
    readonly issue: Extract<InferIssue<TSchema>, {
      type: TSchema["type"];
    }> | InferObjectIssue<Omit<TEntries, TKeys[number]>>;
  } | undefined;
} : TSchema extends ObjectWithRestSchema<infer TEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: Omit<TEntries, TKeys[number]>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<Omit<TEntries, TKeys[number]>> & {
    [key: string]: InferInput<TSchema["rest"]>;
  }, InferObjectOutput<Omit<TEntries, TKeys[number]>> & {
    [key: string]: InferOutput<TSchema["rest"]>;
  }>;
  /**
  * Parses unknown input.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => OutputDataset<InferObjectOutput<Omit<TEntries, TKeys[number]>> & {
    [key: string]: InferOutput<TSchema["rest"]>;
  }, Extract<InferIssue<TSchema>, {
    type: TSchema["type"];
  }> | InferObjectIssue<Omit<TEntries, TKeys[number]>> | InferIssue<TSchema["rest"]>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<Omit<TEntries, TKeys[number]>> & {
      [key: string]: InferInput<TSchema["rest"]>;
    };
    readonly output: InferObjectOutput<Omit<TEntries, TKeys[number]>> & {
      [key: string]: InferOutput<TSchema["rest"]>;
    };
    readonly issue: Extract<InferIssue<TSchema>, {
      type: TSchema["type"];
    }> | InferObjectIssue<Omit<TEntries, TKeys[number]>> | InferIssue<TSchema["rest"]>;
  } | undefined;
} : TSchema extends ObjectWithRestSchemaAsync<infer TEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: Omit<TEntries, TKeys[number]>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<Omit<TEntries, TKeys[number]>> & {
    [key: string]: InferInput<TSchema["rest"]>;
  }, InferObjectOutput<Omit<TEntries, TKeys[number]>> & {
    [key: string]: InferOutput<TSchema["rest"]>;
  }>;
  /**
  * Parses unknown input.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => Promise<OutputDataset<InferObjectOutput<Omit<TEntries, TKeys[number]>> & {
    [key: string]: InferOutput<TSchema["rest"]>;
  }, Extract<InferIssue<TSchema>, {
    type: TSchema["type"];
  }> | InferObjectIssue<Omit<TEntries, TKeys[number]>> | InferIssue<TSchema["rest"]>>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<Omit<TEntries, TKeys[number]>> & {
      [key: string]: InferInput<TSchema["rest"]>;
    };
    readonly output: InferObjectOutput<Omit<TEntries, TKeys[number]>> & {
      [key: string]: InferOutput<TSchema["rest"]>;
    };
    readonly issue: Extract<InferIssue<TSchema>, {
      type: TSchema["type"];
    }> | InferObjectIssue<Omit<TEntries, TKeys[number]>> | InferIssue<TSchema["rest"]>;
  } | undefined;
} : never;
/**
* Creates a modified copy of an object schema that does not contain the
* selected entries.
*
* @param schema The schema to omit from.
* @param keys The selected entries.
*
* @returns An object schema.
*/
declare function omit<const TSchema extends Schema$9, const TKeys extends ObjectKeys<TSchema>>(schema: TSchema, keys: TKeys): SchemaWithOmit<TSchema, TKeys>;
//#endregion
//#region src/methods/parse/parse.d.ts
/**
* Parses an unknown input based on a schema.
*
* @param schema The schema to be used.
* @param input The input to be parsed.
* @param config The parse configuration.
*
* @returns The parsed input.
*/
declare function parse<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema, input: unknown, config?: Config<InferIssue<TSchema>>): InferOutput<TSchema>;
//#endregion
//#region src/methods/parse/parseAsync.d.ts
/**
* Parses an unknown input based on a schema.
*
* @param schema The schema to be used.
* @param input The input to be parsed.
* @param config The parse configuration.
*
* @returns The parsed input.
*/
declare function parseAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema, input: unknown, config?: Config<InferIssue<TSchema>>): Promise<InferOutput<TSchema>>;
//#endregion
//#region src/methods/parser/parser.d.ts
/**
* The parser interface.
*/
interface Parser<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TConfig extends Config<InferIssue<TSchema>> | undefined> {
  /**
  * Parses an unknown input based on the schema.
  */
  (input: unknown): InferOutput<TSchema>;
  /**
  * The schema to be used.
  */
  readonly schema: TSchema;
  /**
  * The parser configuration.
  */
  readonly config: TConfig;
}
/**
* Returns a function that parses an unknown input based on a schema.
*
* @param schema The schema to be used.
*
* @returns The parser function.
*/
declare function parser<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema): Parser<TSchema, undefined>;
/**
* Returns a function that parses an unknown input based on a schema.
*
* @param schema The schema to be used.
* @param config The parser configuration.
*
* @returns The parser function.
*/
declare function parser<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TConfig extends Config<InferIssue<TSchema>> | undefined>(schema: TSchema, config: TConfig): Parser<TSchema, TConfig>;
//#endregion
//#region src/methods/parser/parserAsync.d.ts
/**
* The parser async interface.
*/
interface ParserAsync<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TConfig extends Config<InferIssue<TSchema>> | undefined> {
  /**
  * Parses an unknown input based on the schema.
  */
  (input: unknown): Promise<InferOutput<TSchema>>;
  /**
  * The schema to be used.
  */
  readonly schema: TSchema;
  /**
  * The parser configuration.
  */
  readonly config: TConfig;
}
/**
* Returns a function that parses an unknown input based on a schema.
*
* @param schema The schema to be used.
*
* @returns The parser function.
*/
declare function parserAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema): ParserAsync<TSchema, undefined>;
/**
* Returns a function that parses an unknown input based on a schema.
*
* @param schema The schema to be used.
* @param config The parser configuration.
*
* @returns The parser function.
*/
declare function parserAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TConfig extends Config<InferIssue<TSchema>> | undefined>(schema: TSchema, config: TConfig): ParserAsync<TSchema, TConfig>;
//#endregion
//#region src/methods/partial/partial.d.ts
/**
* Schema type.
*/
type Schema$8 = SchemaWithoutPipe<LooseObjectSchema<ObjectEntries, ErrorMessage<LooseObjectIssue> | undefined> | ObjectSchema<ObjectEntries, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchema<ObjectEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchema<ObjectEntries, ErrorMessage<StrictObjectIssue> | undefined>>;
/**
* Partial entries type.
*/
type PartialEntries$1<TEntries$1 extends ObjectEntries, TKeys extends readonly (keyof TEntries$1)[] | undefined> = { [TKey in keyof TEntries$1]: TKeys extends readonly (keyof TEntries$1)[] ? TKey extends TKeys[number] ? OptionalSchema<TEntries$1[TKey], undefined> : TEntries$1[TKey] : OptionalSchema<TEntries$1[TKey], undefined> };
/**
* Schema with partial type.
*/
type SchemaWithPartial<TSchema extends Schema$8, TKeys extends ObjectKeys<TSchema> | undefined> = TSchema extends ObjectSchema<infer TEntries, ErrorMessage<ObjectIssue> | undefined> | StrictObjectSchema<infer TEntries, ErrorMessage<StrictObjectIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: PartialEntries$1<TEntries, TKeys>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<PartialEntries$1<TEntries, TKeys>>, InferObjectOutput<PartialEntries$1<TEntries, TKeys>>>;
  /**
  * Parses unknown input.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => OutputDataset<InferObjectOutput<PartialEntries$1<TEntries, TKeys>>, InferIssue<TSchema>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<PartialEntries$1<TEntries, TKeys>>;
    readonly output: InferObjectOutput<PartialEntries$1<TEntries, TKeys>>;
    readonly issue: InferIssue<TSchema>;
  } | undefined;
} : TSchema extends LooseObjectSchema<infer TEntries, ErrorMessage<LooseObjectIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: PartialEntries$1<TEntries, TKeys>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<PartialEntries$1<TEntries, TKeys>> & {
    [key: string]: unknown;
  }, InferObjectOutput<PartialEntries$1<TEntries, TKeys>> & {
    [key: string]: unknown;
  }>;
  /**
  * Parses unknown input.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => OutputDataset<InferObjectOutput<PartialEntries$1<TEntries, TKeys>> & {
    [key: string]: unknown;
  }, InferIssue<TSchema>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<PartialEntries$1<TEntries, TKeys>> & {
      [key: string]: unknown;
    };
    readonly output: InferObjectOutput<PartialEntries$1<TEntries, TKeys>> & {
      [key: string]: unknown;
    };
    readonly issue: InferIssue<TSchema>;
  } | undefined;
} : TSchema extends ObjectWithRestSchema<infer TEntries, infer TRest, ErrorMessage<ObjectWithRestIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: PartialEntries$1<TEntries, TKeys>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<PartialEntries$1<TEntries, TKeys>> & {
    [key: string]: InferInput<TRest>;
  }, InferObjectOutput<PartialEntries$1<TEntries, TKeys>> & {
    [key: string]: InferOutput<TRest>;
  }>;
  /**
  * Parses unknown input.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => OutputDataset<InferObjectOutput<PartialEntries$1<TEntries, TKeys>> & {
    [key: string]: InferOutput<TRest>;
  }, InferIssue<TSchema>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<PartialEntries$1<TEntries, TKeys>> & {
      [key: string]: InferInput<TRest>;
    };
    readonly output: InferObjectOutput<PartialEntries$1<TEntries, TKeys>> & {
      [key: string]: InferOutput<TRest>;
    };
    readonly issue: InferIssue<TSchema>;
  } | undefined;
} : never;
/**
* Creates a modified copy of an object schema that marks all entries as optional.
*
* @param schema The schema to modify.
*
* @returns An object schema.
*/
declare function partial<const TSchema extends Schema$8>(schema: TSchema): SchemaWithPartial<TSchema, undefined>;
/**
* Creates a modified copy of an object schema that marks the selected entries
* as optional.
*
* @param schema The schema to modify.
* @param keys The selected entries.
*
* @returns An object schema.
*/
declare function partial<const TSchema extends Schema$8, const TKeys extends ObjectKeys<TSchema>>(schema: TSchema, keys: TKeys): SchemaWithPartial<TSchema, TKeys>;
//#endregion
//#region src/methods/partial/partialAsync.d.ts
/**
* Schema type.
*/
type Schema$7 = SchemaWithoutPipe<LooseObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<LooseObjectIssue> | undefined> | ObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchemaAsync<ObjectEntriesAsync, BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<StrictObjectIssue> | undefined>>;
/**
* Partial entries type.
*/
type PartialEntries<TEntries$1 extends ObjectEntriesAsync, TKeys extends readonly (keyof TEntries$1)[] | undefined> = { [TKey in keyof TEntries$1]: TKeys extends readonly (keyof TEntries$1)[] ? TKey extends TKeys[number] ? OptionalSchemaAsync<TEntries$1[TKey], undefined> : TEntries$1[TKey] : OptionalSchemaAsync<TEntries$1[TKey], undefined> };
/**
* Schema with partial type.
*/
type SchemaWithPartialAsync<TSchema extends Schema$7, TKeys extends ObjectKeys<TSchema> | undefined> = TSchema extends ObjectSchemaAsync<infer TEntries, ErrorMessage<ObjectIssue> | undefined> | StrictObjectSchemaAsync<infer TEntries, ErrorMessage<StrictObjectIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: PartialEntries<TEntries, TKeys>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<PartialEntries<TEntries, TKeys>>, InferObjectOutput<PartialEntries<TEntries, TKeys>>>;
  /**
  * Parses unknown input.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => Promise<OutputDataset<InferObjectOutput<PartialEntries<TEntries, TKeys>>, InferIssue<TSchema>>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<PartialEntries<TEntries, TKeys>>;
    readonly output: InferObjectOutput<PartialEntries<TEntries, TKeys>>;
    readonly issue: InferIssue<TSchema>;
  } | undefined;
} : TSchema extends LooseObjectSchemaAsync<infer TEntries, ErrorMessage<LooseObjectIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: PartialEntries<TEntries, TKeys>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<PartialEntries<TEntries, TKeys>> & {
    [key: string]: unknown;
  }, InferObjectOutput<PartialEntries<TEntries, TKeys>> & {
    [key: string]: unknown;
  }>;
  /**
  * Parses unknown input.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => Promise<OutputDataset<InferObjectOutput<PartialEntries<TEntries, TKeys>> & {
    [key: string]: unknown;
  }, InferIssue<TSchema>>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<PartialEntries<TEntries, TKeys>> & {
      [key: string]: unknown;
    };
    readonly output: InferObjectOutput<PartialEntries<TEntries, TKeys>> & {
      [key: string]: unknown;
    };
    readonly issue: InferIssue<TSchema>;
  } | undefined;
} : TSchema extends ObjectWithRestSchemaAsync<infer TEntries, infer TRest, ErrorMessage<ObjectWithRestIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: PartialEntries<TEntries, TKeys>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<PartialEntries<TEntries, TKeys>> & {
    [key: string]: InferInput<TRest>;
  }, InferObjectOutput<PartialEntries<TEntries, TKeys>> & {
    [key: string]: InferOutput<TRest>;
  }>;
  /**
  * Parses unknown input.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => Promise<OutputDataset<InferObjectOutput<PartialEntries<TEntries, TKeys>> & {
    [key: string]: InferOutput<TRest>;
  }, InferIssue<TSchema>>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<PartialEntries<TEntries, TKeys>> & {
      [key: string]: InferInput<TRest>;
    };
    readonly output: InferObjectOutput<PartialEntries<TEntries, TKeys>> & {
      [key: string]: InferOutput<TRest>;
    };
    readonly issue: InferIssue<TSchema>;
  } | undefined;
} : never;
/**
* Creates a modified copy of an object schema that marks all entries as optional.
*
* @param schema The schema to modify.
*
* @returns An object schema.
*/
declare function partialAsync<const TSchema extends Schema$7>(schema: TSchema): SchemaWithPartialAsync<TSchema, undefined>;
/**
* Creates a modified copy of an object schema that marks the selected entries
* as optional.
*
* @param schema The schema to modify.
* @param keys The selected entries.
*
* @returns An object schema.
*/
declare function partialAsync<const TSchema extends Schema$7, const TKeys extends ObjectKeys<TSchema>>(schema: TSchema, keys: TKeys): SchemaWithPartialAsync<TSchema, TKeys>;
//#endregion
//#region src/methods/pick/pick.d.ts
/**
* The schema type.
*/
type Schema$6 = SchemaWithoutPipe<LooseObjectSchema<ObjectEntries, ErrorMessage<LooseObjectIssue> | undefined> | LooseObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<LooseObjectIssue> | undefined> | ObjectSchema<ObjectEntries, ErrorMessage<ObjectIssue> | undefined> | ObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchema<ObjectEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | ObjectWithRestSchemaAsync<ObjectEntriesAsync, BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchema<ObjectEntries, ErrorMessage<StrictObjectIssue> | undefined> | StrictObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<StrictObjectIssue> | undefined>>;
export { assert, Cache, CacheConfig, SchemaWithCache, cache, SchemaWithCacheAsync, cacheAsync, config, Fallback, SchemaWithFallback, fallback, FallbackAsync, SchemaWithFallbackAsync, fallbackAsync, FlatErrors, flatten, KeyOf$1, Path$1, RequiredPath$1, LazyPath$1, ValidPath$1, forward, forwardAsync, SchemaWithDefault, SchemaWithDefaultAsync, InferDefault, getDefault, InferDefaults, getDefaults, getDefaultsAsync, Schema$14, getDescription, Schema$13, RecursiveConcat, InferExamples, getExamples, InferFallback, getFallback, InferFallbacks, getFallbacks, getFallbacksAsync, SchemaWithPipe, pipe, SchemaWithPipeAsync, pipeAsync, Schema$12, BasicPipeItem, RecursiveMerge$1, InferMetadata, getMetadata, TitleAction, title, Schema$11, getTitle, is, Schema$10, ForceTuple, ObjectKeys$1, keyof, message, Schema$9, SchemaWithOmit, omit, parse, parseAsync, Parser, parser, ParserAsync, parserAsync, Schema$8, PartialEntries$1, SchemaWithPartial, partial, Schema$7, PartialEntries, SchemaWithPartialAsync, partialAsync, Schema$6 };
