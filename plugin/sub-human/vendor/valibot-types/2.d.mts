import { assert, Cache, CacheConfig, SchemaWithCache, cache, SchemaWithCacheAsync, cacheAsync, config, Fallback, SchemaWithFallback, fallback, FallbackAsync, SchemaWithFallbackAsync, fallbackAsync, FlatErrors, flatten, KeyOf$1, Path$1, RequiredPath$1, LazyPath$1, ValidPath$1, forward, forwardAsync, SchemaWithDefault, SchemaWithDefaultAsync, InferDefault, getDefault, InferDefaults, getDefaults, getDefaultsAsync, Schema$14, getDescription, Schema$13, RecursiveConcat, InferExamples, getExamples, InferFallback, getFallback, InferFallbacks, getFallbacks, getFallbacksAsync, SchemaWithPipe, pipe, SchemaWithPipeAsync, pipeAsync, Schema$12, BasicPipeItem, RecursiveMerge$1, InferMetadata, getMetadata, TitleAction, title, Schema$11, getTitle, is, Schema$10, ForceTuple, ObjectKeys$1, keyof, message, Schema$9, SchemaWithOmit, omit, parse, parseAsync, Parser, parser, ParserAsync, parserAsync, Schema$8, PartialEntries$1, SchemaWithPartial, partial, Schema$7, PartialEntries, SchemaWithPartialAsync, partialAsync, Schema$6 } from './1.d.mts';
import { checkItemsAsync, CodePointsIssue, CodePointsAction, codePoints, CreditCardIssue, CreditCardAction, creditCard, Cuid2Issue, Cuid2Action, cuid2, DecimalIssue, DecimalAction, decimal, DescriptionAction, description, DigitsIssue, DigitsAction, digits, DomainIssue, DomainAction, domain, EmailIssue, EmailAction, email, EmojiIssue, EmojiAction, emoji, EmptyIssue, EmptyAction, empty, EndsWithIssue, EndsWithAction, endsWith, EntriesIssue, EntriesAction, entries, EveryItemIssue, EveryItemAction, everyItem, ExamplesAction, examples, ExcludesIssue, ExcludesAction, excludes, FilterItemsAction, filterItems, ArrayRequirement$1, FindItemAction, findItem, FiniteIssue, FiniteAction, finite, FlavorSymbol, FlavorName, Flavor, FlavorAction, flavor, GraphemesIssue, GraphemesAction, graphemes, GtValueIssue, GtValueAction, gtValue, GuardFunction, InferGuardOutput, GuardIssue, GuardAction, guard, HASH_LENGTHS, HashType, HashIssue, HashAction, hash, HexadecimalIssue, HexadecimalAction, hexadecimal, HexColorIssue, HexColorAction, hexColor, ImeiIssue, ImeiAction, imei, IncludesIssue, IncludesAction, includes, IntegerIssue, IntegerAction, integer, IpIssue, IpAction, ip, Ipv4Issue, Ipv4Action, ipv4, Ipv6Issue, Ipv6Action, ipv6, IsbnIssue, IsbnAction, isbn, IsrcIssue, IsrcAction, isrc, IsoDateIssue, IsoDateAction, isoDate, IsoDateTimeIssue, IsoDateTimeAction, isoDateTime, IsoDateTimeSecondIssue, IsoDateTimeSecondAction, isoDateTimeSecond, IsoTimeIssue, IsoTimeAction, isoTime, IsoTimeSecondIssue, IsoTimeSecondAction, isoTimeSecond, IsoTimestampIssue, IsoTimestampAction, isoTimestamp, IsoWeekIssue, IsoWeekAction, isoWeek, JwsCompactIssue, JwsCompactAction, jwsCompact, KsuidIssue, KsuidAction, ksuid, LengthIssue, LengthAction, length, LtValueIssue, LtValueAction, ltValue, MacIssue, MacAction, mac, Mac48Issue, Mac48Action, mac48, Mac64Issue, Mac64Action, mac64, ArrayAction$2, MapItemsAction, mapItems, MaxBytesIssue, MaxBytesAction, maxBytes, MaxCodePointsIssue, MaxCodePointsAction, maxCodePoints, MaxEntriesIssue, MaxEntriesAction, maxEntries, MaxGraphemesIssue, MaxGraphemesAction, maxGraphemes, MaxLengthIssue, MaxLengthAction, maxLength, MaxSizeIssue, MaxSizeAction, maxSize, MaxValueIssue, MaxValueAction, maxValue, MaxWordsIssue, MaxWordsAction, maxWords, MetadataAction, metadata, Requirement, MimeTypeIssue, MimeTypeAction, mimeType, MinBytesIssue, MinBytesAction, minBytes, MinCodePointsIssue, MinCodePointsAction, minCodePoints, MinEntriesIssue, MinEntriesAction, minEntries, MinGraphemesIssue, MinGraphemesAction, minGraphemes, MinLengthIssue, MinLengthAction, minLength, MinSizeIssue, MinSizeAction, minSize, MinValueIssue, MinValueAction, minValue, MinWordsIssue, MinWordsAction, minWords, Input, MultipleOfIssue, MultipleOfAction, multipleOf, NanoIdIssue, NanoIDIssue, NanoIdAction, NanoIDAction, nanoid, NonEmptyIssue, NonEmptyAction, nonEmpty, NormalizeForm, NormalizeAction, normalize, NotBytesIssue, NotBytesAction, notBytes, NotCodePointsIssue, NotCodePointsAction, notCodePoints, NotEntriesIssue, NotEntriesAction, notEntries, NotGraphemesIssue, NotGraphemesAction, notGraphemes, NotLengthIssue, NotLengthAction, notLength, NotSizeIssue, NotSizeAction, notSize, NotValueIssue, NotValueAction, notValue, NotValuesIssue, NotValuesAction, notValues, NotWordsIssue, NotWordsAction, notWords, OctalIssue, OctalAction, octal, ParseBooleanConfig, ParseBooleanIssue, ParseBooleanAction, parseBoolean, ParseJsonConfig, ParseJsonIssue, ParseJsonAction, parseJson, PartialInput, PartialCheckIssue, KeyOf, Path, RequiredPath, Paths, RequiredPaths, LazyPath, ValidPath, ValidPaths, DeepPick, DeepMerge, DeepPickN, PartialCheckAction, partialCheck, PartialCheckActionAsync, partialCheckAsync, RawCheckIssue, RawCheckIssueInfo, RawCheckAddIssue, RawCheckContext, RawCheckAction, rawCheck, RawCheckActionAsync, rawCheckAsync, RawTransformIssue, RawTransformIssueInfo, RawTransformAddIssue, RawTransformContext, RawTransformAction, rawTransform, RawTransformActionAsync, rawTransformAsync, ReadonlyOutput, ReadonlyAction, readonly, ArrayAction$1, ReduceItemsAction, reduceItems, RegexIssue, RegexAction, regex, ReturnsAction, returns, ReturnsActionAsync, returnsAsync, RfcEmailIssue, RfcEmailAction, rfcEmail, SafeIntegerIssue, SafeIntegerAction, safeInteger, SizeIssue, SizeAction, size, SlugIssue, SlugAction, slug, SomeItemIssue, SomeItemAction, someItem, ArrayAction, SortItemsAction, sortItems, StartsWithIssue, StartsWithAction, startsWith, StringifyJsonConfig, StringifyJsonIssue, StringifyJsonAction, stringifyJson, ToBigintIssue, ToBigintAction, toBigint, ToBooleanAction, toBoolean, ToCamelCaseAction, toCamelCase, ToDateIssue, ToDateAction, toDate, ToKebabCaseAction, toKebabCase, ToLowerCaseAction, toLowerCase, ToMaxValueAction, toMaxValue, ToMinValueAction, toMinValue, ToNumberIssue, ToNumberAction, toNumber, ToPascalCaseAction, toPascalCase, ToSnakeCaseAction, toSnakeCase, ToStringIssue, ToStringAction, toString, ToUpperCaseAction, toUpperCase, TransformAction, transform, TransformActionAsync, transformAsync, TrimAction, trim, TrimEndAction, trimEnd, TrimStartAction, trimStart, UlidIssue, UlidAction, ulid, UrlIssue, UrlAction, url, UuidIssue, UuidAction } from './3.d.mts';
import { uuid, ValueIssue, ValueAction, value, ValuesIssue, ValuesAction, values, WordsIssue, WordsAction, words, BASE64_REGEX, BIC_REGEX, CUID2_REGEX, DECIMAL_REGEX, DIGITS_REGEX, DOMAIN_REGEX, EMAIL_REGEX, EMOJI_REGEX, HEXADECIMAL_REGEX, HEX_COLOR_REGEX, IMEI_REGEX, IPV4_REGEX, IPV6_REGEX, IP_REGEX, ISO_DATE_REGEX, ISO_DATE_TIME_REGEX, ISO_DATE_TIME_SECOND_REGEX, ISO_TIME_REGEX, ISO_TIME_SECOND_REGEX, ISO_TIMESTAMP_REGEX, ISO_WEEK_REGEX, JWS_COMPACT_REGEX, ISRC_REGEX, KSUID_REGEX, MAC48_REGEX, MAC64_REGEX, MAC_REGEX, NANO_ID_REGEX, OCTAL_REGEX, RFC_EMAIL_REGEX, SLUG_REGEX, ULID_REGEX, UUID_REGEX, GlobalConfig, setGlobalConfig, getGlobalConfig, deleteGlobalConfig, setGlobalMessage, getGlobalMessage, deleteGlobalMessage, setSchemaMessage, getSchemaMessage, deleteSchemaMessage, Reference, setSpecificMessage, getSpecificMessage, deleteSpecificMessage, Context, Other, _addIssue, _cloneDataset, _formatCase, _getByteCount, _getCodePointCount, _getGraphemeCount, MetadataAction$1, Schema$1, _getLastMetadata, _getWordCount, _isLuhnAlgo, _isSameValueZero, _isValidObjectKey, _isValueMatch, _joinExpects, _standardSchema, _stringify, entriesFromList, Schema, RecursiveMerge, MergedEntries, entriesFromObjects, getDotPath, isOfKind, isOfType, ValiError, isValiError } from './4.d.mts';
/**
* Schema with pick type.
*/
type SchemaWithPick<TSchema extends Schema$6, TKeys extends ObjectKeys<TSchema>> = TSchema extends ObjectSchema<infer TEntries, ErrorMessage<ObjectIssue> | undefined> | StrictObjectSchema<infer TEntries, ErrorMessage<StrictObjectIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: Pick<TEntries, TKeys[number]>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<Pick<TEntries, TKeys[number]>>, InferObjectOutput<Pick<TEntries, TKeys[number]>>>;
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
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => OutputDataset<InferObjectOutput<Pick<TEntries, TKeys[number]>>, Extract<InferIssue<TSchema>, {
    type: TSchema["type"];
  }> | InferObjectIssue<Pick<TEntries, TKeys[number]>>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<Pick<TEntries, TKeys[number]>>;
    readonly output: InferObjectOutput<Pick<TEntries, TKeys[number]>>;
    readonly issue: Extract<InferIssue<TSchema>, {
      type: TSchema["type"];
    }> | InferObjectIssue<Pick<TEntries, TKeys[number]>>;
  } | undefined;
} : TSchema extends ObjectSchemaAsync<infer TEntries, ErrorMessage<ObjectIssue> | undefined> | StrictObjectSchemaAsync<infer TEntries, ErrorMessage<StrictObjectIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: Pick<TEntries, TKeys[number]>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<Pick<TEntries, TKeys[number]>>, InferObjectOutput<Pick<TEntries, TKeys[number]>>>;
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
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => Promise<OutputDataset<InferObjectOutput<Pick<TEntries, TKeys[number]>>, Extract<InferIssue<TSchema>, {
    type: TSchema["type"];
  }> | InferObjectIssue<Pick<TEntries, TKeys[number]>>>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<Pick<TEntries, TKeys[number]>>;
    readonly output: InferObjectOutput<Pick<TEntries, TKeys[number]>>;
    readonly issue: Extract<InferIssue<TSchema>, {
      type: TSchema["type"];
    }> | InferObjectIssue<Pick<TEntries, TKeys[number]>>;
  } | undefined;
} : TSchema extends LooseObjectSchema<infer TEntries, ErrorMessage<LooseObjectIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: Pick<TEntries, TKeys[number]>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<Pick<TEntries, TKeys[number]>> & {
    [key: string]: unknown;
  }, InferObjectOutput<Pick<TEntries, TKeys[number]>> & {
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
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => OutputDataset<InferObjectOutput<Pick<TEntries, TKeys[number]>> & {
    [key: string]: unknown;
  }, Extract<InferIssue<TSchema>, {
    type: TSchema["type"];
  }> | InferObjectIssue<Pick<TEntries, TKeys[number]>>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<Pick<TEntries, TKeys[number]>> & {
      [key: string]: unknown;
    };
    readonly output: InferObjectOutput<Pick<TEntries, TKeys[number]>> & {
      [key: string]: unknown;
    };
    readonly issue: Extract<InferIssue<TSchema>, {
      type: TSchema["type"];
    }> | InferObjectIssue<Pick<TEntries, TKeys[number]>>;
  } | undefined;
} : TSchema extends LooseObjectSchemaAsync<infer TEntries, ErrorMessage<LooseObjectIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: Pick<TEntries, TKeys[number]>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<Pick<TEntries, TKeys[number]>> & {
    [key: string]: unknown;
  }, InferObjectOutput<Pick<TEntries, TKeys[number]>> & {
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
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => Promise<OutputDataset<InferObjectOutput<Pick<TEntries, TKeys[number]>> & {
    [key: string]: unknown;
  }, Extract<InferIssue<TSchema>, {
    type: TSchema["type"];
  }> | InferObjectIssue<Pick<TEntries, TKeys[number]>>>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<Pick<TEntries, TKeys[number]>> & {
      [key: string]: unknown;
    };
    readonly output: InferObjectOutput<Pick<TEntries, TKeys[number]>> & {
      [key: string]: unknown;
    };
    readonly issue: Extract<InferIssue<TSchema>, {
      type: TSchema["type"];
    }> | InferObjectIssue<Pick<TEntries, TKeys[number]>>;
  } | undefined;
} : TSchema extends ObjectWithRestSchema<infer TEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: Pick<TEntries, TKeys[number]>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<Pick<TEntries, TKeys[number]>> & {
    [key: string]: InferInput<TSchema["rest"]>;
  }, InferObjectOutput<Pick<TEntries, TKeys[number]>> & {
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
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => OutputDataset<InferObjectOutput<Pick<TEntries, TKeys[number]>> & {
    [key: string]: InferOutput<TSchema["rest"]>;
  }, Extract<InferIssue<TSchema>, {
    type: TSchema["type"];
  }> | InferObjectIssue<Pick<TEntries, TKeys[number]>> | InferIssue<TSchema["rest"]>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<Pick<TEntries, TKeys[number]>> & {
      [key: string]: InferInput<TSchema["rest"]>;
    };
    readonly output: InferObjectOutput<Pick<TEntries, TKeys[number]>> & {
      [key: string]: InferOutput<TSchema["rest"]>;
    };
    readonly issue: Extract<InferIssue<TSchema>, {
      type: TSchema["type"];
    }> | InferObjectIssue<Pick<TEntries, TKeys[number]>> | InferIssue<TSchema["rest"]>;
  } | undefined;
} : TSchema extends ObjectWithRestSchemaAsync<infer TEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: Pick<TEntries, TKeys[number]>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<Pick<TEntries, TKeys[number]>> & {
    [key: string]: InferInput<TSchema["rest"]>;
  }, InferObjectOutput<Pick<TEntries, TKeys[number]>> & {
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
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => Promise<OutputDataset<InferObjectOutput<Pick<TEntries, TKeys[number]>> & {
    [key: string]: InferOutput<TSchema["rest"]>;
  }, Extract<InferIssue<TSchema>, {
    type: TSchema["type"];
  }> | InferObjectIssue<Pick<TEntries, TKeys[number]>> | InferIssue<TSchema["rest"]>>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<Pick<TEntries, TKeys[number]>> & {
      [key: string]: InferInput<TSchema["rest"]>;
    };
    readonly output: InferObjectOutput<Pick<TEntries, TKeys[number]>> & {
      [key: string]: InferOutput<TSchema["rest"]>;
    };
    readonly issue: Extract<InferIssue<TSchema>, {
      type: TSchema["type"];
    }> | InferObjectIssue<Pick<TEntries, TKeys[number]>> | InferIssue<TSchema["rest"]>;
  } | undefined;
} : never;
/**
* Creates a modified copy of an object schema that contains only the selected
* entries.
*
* @param schema The schema to pick from.
* @param keys The selected entries.
*
* @returns An object schema.
*/
declare function pick<const TSchema extends Schema$6, const TKeys extends ObjectKeys<TSchema>>(schema: TSchema, keys: TKeys): SchemaWithPick<TSchema, TKeys>;
//#endregion
//#region src/methods/required/required.d.ts
/**
* Schema type.
*/
type Schema$5 = SchemaWithoutPipe<LooseObjectSchema<ObjectEntries, ErrorMessage<LooseObjectIssue> | undefined> | ObjectSchema<ObjectEntries, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchema<ObjectEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchema<ObjectEntries, ErrorMessage<StrictObjectIssue> | undefined>>;
/**
* Required entries type.
*/
type RequiredEntries$1<TEntries$1 extends ObjectEntries, TKeys extends readonly (keyof TEntries$1)[] | undefined, TMessage extends ErrorMessage<NonOptionalIssue> | undefined> = { [TKey in keyof TEntries$1]: TKeys extends readonly (keyof TEntries$1)[] ? TKey extends TKeys[number] ? NonOptionalSchema<TEntries$1[TKey], TMessage> : TEntries$1[TKey] : NonOptionalSchema<TEntries$1[TKey], TMessage> };
/**
* Schema with required type.
*/
type SchemaWithRequired<TSchema extends Schema$5, TKeys extends ObjectKeys<TSchema> | undefined, TMessage extends ErrorMessage<NonOptionalIssue> | undefined> = TSchema extends ObjectSchema<infer TEntries, ErrorMessage<ObjectIssue> | undefined> | StrictObjectSchema<infer TEntries, ErrorMessage<StrictObjectIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: RequiredEntries$1<TEntries, TKeys, TMessage>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<RequiredEntries$1<TEntries, TKeys, TMessage>>, InferObjectOutput<RequiredEntries$1<TEntries, TKeys, TMessage>>>;
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
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => OutputDataset<InferObjectOutput<RequiredEntries$1<TEntries, TKeys, TMessage>>, NonOptionalIssue | InferIssue<TSchema>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<RequiredEntries$1<TEntries, TKeys, TMessage>>;
    readonly output: InferObjectOutput<RequiredEntries$1<TEntries, TKeys, TMessage>>;
    readonly issue: NonOptionalIssue | InferIssue<TSchema>;
  } | undefined;
} : TSchema extends LooseObjectSchema<infer TEntries, ErrorMessage<LooseObjectIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: RequiredEntries$1<TEntries, TKeys, TMessage>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<RequiredEntries$1<TEntries, TKeys, TMessage>> & {
    [key: string]: unknown;
  }, InferObjectOutput<RequiredEntries$1<TEntries, TKeys, TMessage>> & {
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
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => OutputDataset<InferObjectOutput<RequiredEntries$1<TEntries, TKeys, TMessage>> & {
    [key: string]: unknown;
  }, NonOptionalIssue | InferIssue<TSchema>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<RequiredEntries$1<TEntries, TKeys, TMessage>> & {
      [key: string]: unknown;
    };
    readonly output: InferObjectOutput<RequiredEntries$1<TEntries, TKeys, TMessage>> & {
      [key: string]: unknown;
    };
    readonly issue: NonOptionalIssue | InferIssue<TSchema>;
  } | undefined;
} : TSchema extends ObjectWithRestSchema<infer TEntries, infer TRest, ErrorMessage<ObjectWithRestIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: RequiredEntries$1<TEntries, TKeys, TMessage>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<RequiredEntries$1<TEntries, TKeys, TMessage>> & {
    [key: string]: InferInput<TRest>;
  }, InferObjectOutput<RequiredEntries$1<TEntries, TKeys, TMessage>> & {
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
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => OutputDataset<InferObjectOutput<RequiredEntries$1<TEntries, TKeys, TMessage>> & {
    [key: string]: InferOutput<TRest>;
  }, NonOptionalIssue | InferIssue<TSchema>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<RequiredEntries$1<TEntries, TKeys, TMessage>> & {
      [key: string]: InferInput<TRest>;
    };
    readonly output: InferObjectOutput<RequiredEntries$1<TEntries, TKeys, TMessage>> & {
      [key: string]: InferOutput<TRest>;
    };
    readonly issue: NonOptionalIssue | InferIssue<TSchema>;
  } | undefined;
} : never;
/**
* Creates a modified copy of an object schema that marks all entries as required.
*
* @param schema The schema to modify.
*
* @returns An object schema.
*/
declare function required<const TSchema extends Schema$5>(schema: TSchema): SchemaWithRequired<TSchema, undefined, undefined>;
/**
* Creates a modified copy of an object schema that marks all entries as required.
*
* @param schema The schema to modify.
* @param message The error message.
*
* @returns An object schema.
*/
declare function required<const TSchema extends Schema$5, const TMessage extends ErrorMessage<NonOptionalIssue> | undefined>(schema: TSchema, message: TMessage): SchemaWithRequired<TSchema, undefined, TMessage>;
/**
* Creates a modified copy of an object schema that marks the selected entries
* as required.
*
* @param schema The schema to modify.
* @param keys The selected entries.
*
* @returns An object schema.
*/
declare function required<const TSchema extends Schema$5, const TKeys extends ObjectKeys<TSchema>>(schema: TSchema, keys: TKeys): SchemaWithRequired<TSchema, TKeys, undefined>;
/**
* Creates a modified copy of an object schema that marks the selected entries
* as required.
*
* @param schema The schema to modify.
* @param keys The selected entries.
* @param message The error message.
*
* @returns An object schema.
*/
declare function required<const TSchema extends Schema$5, const TKeys extends ObjectKeys<TSchema>, const TMessage extends ErrorMessage<NonOptionalIssue> | undefined>(schema: TSchema, keys: TKeys, message: TMessage): SchemaWithRequired<TSchema, TKeys, TMessage>;
//#endregion
//#region src/methods/required/requiredAsync.d.ts
/**
* Schema type.
*/
type Schema$4 = SchemaWithoutPipe<LooseObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<LooseObjectIssue> | undefined> | ObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchemaAsync<ObjectEntriesAsync, BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<StrictObjectIssue> | undefined>>;
/**
* Required entries type.
*/
type RequiredEntries<TEntries$1 extends ObjectEntriesAsync, TKeys extends readonly (keyof TEntries$1)[] | undefined, TMessage extends ErrorMessage<NonOptionalIssue> | undefined> = { [TKey in keyof TEntries$1]: TKeys extends readonly (keyof TEntries$1)[] ? TKey extends TKeys[number] ? NonOptionalSchemaAsync<TEntries$1[TKey], TMessage> : TEntries$1[TKey] : NonOptionalSchemaAsync<TEntries$1[TKey], TMessage> };
/**
* Schema with required type.
*/
type SchemaWithRequiredAsync<TSchema extends Schema$4, TKeys extends ObjectKeys<TSchema> | undefined, TMessage extends ErrorMessage<NonOptionalIssue> | undefined> = TSchema extends ObjectSchemaAsync<infer TEntries, ErrorMessage<ObjectIssue> | undefined> | StrictObjectSchemaAsync<infer TEntries, ErrorMessage<StrictObjectIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: RequiredEntries<TEntries, TKeys, TMessage>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<RequiredEntries<TEntries, TKeys, TMessage>>, InferObjectOutput<RequiredEntries<TEntries, TKeys, TMessage>>>;
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
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => Promise<OutputDataset<InferObjectOutput<RequiredEntries<TEntries, TKeys, TMessage>>, NonOptionalIssue | InferIssue<TSchema>>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<RequiredEntries<TEntries, TKeys, TMessage>>;
    readonly output: InferObjectOutput<RequiredEntries<TEntries, TKeys, TMessage>>;
    readonly issue: NonOptionalIssue | InferIssue<TSchema>;
  } | undefined;
} : TSchema extends LooseObjectSchemaAsync<infer TEntries, ErrorMessage<LooseObjectIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: RequiredEntries<TEntries, TKeys, TMessage>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<RequiredEntries<TEntries, TKeys, TMessage>> & {
    [key: string]: unknown;
  }, InferObjectOutput<RequiredEntries<TEntries, TKeys, TMessage>> & {
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
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => Promise<OutputDataset<InferObjectOutput<RequiredEntries<TEntries, TKeys, TMessage>> & {
    [key: string]: unknown;
  }, NonOptionalIssue | InferIssue<TSchema>>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<RequiredEntries<TEntries, TKeys, TMessage>> & {
      [key: string]: unknown;
    };
    readonly output: InferObjectOutput<RequiredEntries<TEntries, TKeys, TMessage>> & {
      [key: string]: unknown;
    };
    readonly issue: NonOptionalIssue | InferIssue<TSchema>;
  } | undefined;
} : TSchema extends ObjectWithRestSchemaAsync<infer TEntries, infer TRest, ErrorMessage<ObjectWithRestIssue> | undefined> ? Omit<TSchema, "entries" | "~standard" | "~run" | "~types"> & {
  /**
  * The object entries.
  */
  readonly entries: RequiredEntries<TEntries, TKeys, TMessage>;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<InferObjectInput<RequiredEntries<TEntries, TKeys, TMessage>> & {
    [key: string]: InferInput<TRest>;
  }, InferObjectOutput<RequiredEntries<TEntries, TKeys, TMessage>> & {
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
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => Promise<OutputDataset<InferObjectOutput<RequiredEntries<TEntries, TKeys, TMessage>> & {
    [key: string]: InferOutput<TRest>;
  }, NonOptionalIssue | InferIssue<TSchema>>>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: InferObjectInput<RequiredEntries<TEntries, TKeys, TMessage>> & {
      [key: string]: InferInput<TRest>;
    };
    readonly output: InferObjectOutput<RequiredEntries<TEntries, TKeys, TMessage>> & {
      [key: string]: InferOutput<TRest>;
    };
    readonly issue: NonOptionalIssue | InferIssue<TSchema>;
  } | undefined;
} : never;
/**
* Creates a modified copy of an object schema that marks all entries as required.
*
* @param schema The schema to modify.
*
* @returns An object schema.
*/
declare function requiredAsync<const TSchema extends Schema$4>(schema: TSchema): SchemaWithRequiredAsync<TSchema, undefined, undefined>;
/**
* Creates a modified copy of an object schema that marks all entries as required.
*
* @param schema The schema to modify.
* @param message The error message.
*
* @returns An object schema.
*/
declare function requiredAsync<const TSchema extends Schema$4, const TMessage extends ErrorMessage<NonOptionalIssue> | undefined>(schema: TSchema, message: TMessage): SchemaWithRequiredAsync<TSchema, undefined, TMessage>;
/**
* Creates a modified copy of an object schema that marks the selected entries
* as required.
*
* @param schema The schema to modify.
* @param keys The selected entries.
*
* @returns An object schema.
*/
declare function requiredAsync<const TSchema extends Schema$4, const TKeys extends ObjectKeys<TSchema>>(schema: TSchema, keys: TKeys): SchemaWithRequiredAsync<TSchema, TKeys, undefined>;
/**
* Creates a modified copy of an object schema that marks the selected entries
* as required.
*
* @param schema The schema to modify.
* @param keys The selected entries.
* @param message The error message.
*
* @returns An object schema.
*/
declare function requiredAsync<const TSchema extends Schema$4, const TKeys extends ObjectKeys<TSchema>, const TMessage extends ErrorMessage<NonOptionalIssue> | undefined>(schema: TSchema, keys: TKeys, message: TMessage): SchemaWithRequiredAsync<TSchema, TKeys, TMessage>;
//#endregion
//#region src/methods/safeParse/types.d.ts
/**
* Safe parse result type.
*/
type SafeParseResult<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = {
  /**
  * Whether it's typed.
  */
  readonly typed: true;
  /**
  * Whether it's successful.
  */
  readonly success: true;
  /**
  * The output value.
  */
  readonly output: InferOutput<TSchema>;
  /**
  * The issues, if any.
  */
  readonly issues: undefined;
} | {
  readonly typed: true;
  readonly success: false;
  readonly output: InferOutput<TSchema>;
  readonly issues: [InferIssue<TSchema>, ...InferIssue<TSchema>[]];
} | {
  readonly typed: false;
  readonly success: false;
  readonly output: unknown;
  readonly issues: [InferIssue<TSchema>, ...InferIssue<TSchema>[]];
};
//#endregion
//#region src/methods/safeParse/safeParse.d.ts
/**
* Parses an unknown input based on a schema.
*
* @param schema The schema to be used.
* @param input The input to be parsed.
* @param config The parse configuration.
*
* @returns The parse result.
*/
declare function safeParse<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema, input: unknown, config?: Config<InferIssue<TSchema>>): SafeParseResult<TSchema>;
//#endregion
//#region src/methods/safeParse/safeParseAsync.d.ts
/**
* Parses an unknown input based on a schema.
*
* @param schema The schema to be used.
* @param input The input to be parsed.
* @param config The parse configuration.
*
* @returns The parse result.
*/
declare function safeParseAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema, input: unknown, config?: Config<InferIssue<TSchema>>): Promise<SafeParseResult<TSchema>>;
//#endregion
//#region src/methods/safeParser/safeParser.d.ts
/**
* The safe parser interface.
*/
interface SafeParser<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TConfig extends Config<InferIssue<TSchema>> | undefined> {
  /**
  * Parses an unknown input based on the schema.
  */
  (input: unknown): SafeParseResult<TSchema>;
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
declare function safeParser<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema): SafeParser<TSchema, undefined>;
/**
* Returns a function that parses an unknown input based on a schema.
*
* @param schema The schema to be used.
* @param config The parser configuration.
*
* @returns The parser function.
*/
declare function safeParser<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TConfig extends Config<InferIssue<TSchema>> | undefined>(schema: TSchema, config: TConfig): SafeParser<TSchema, TConfig>;
//#endregion
//#region src/methods/safeParser/safeParserAsync.d.ts
/**
* The safe parser async interface.
*/
interface SafeParserAsync<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TConfig extends Config<InferIssue<TSchema>> | undefined> {
  /**
  * Parses an unknown input based on the schema.
  */
  (input: unknown): Promise<SafeParseResult<TSchema>>;
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
declare function safeParserAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(schema: TSchema): SafeParserAsync<TSchema, undefined>;
/**
* Returns a function that parses an unknown input based on a schema.
*
* @param schema The schema to be used.
* @param config The parser configuration.
*
* @returns The parser function.
*/
declare function safeParserAsync<const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TConfig extends Config<InferIssue<TSchema>> | undefined>(schema: TSchema, config: TConfig): SafeParserAsync<TSchema, TConfig>;
//#endregion
//#region src/methods/summarize/summarize.d.ts
/**
* Summarize the error messages of issues in a pretty-printable multi-line string.
*
* @param issues The list of issues.
*
* @returns A summary of the issues.
*
* @beta
*/
declare function summarize(issues: [BaseIssue<unknown>, ...BaseIssue<unknown>[]]): string;
//#endregion
//#region src/methods/unwrap/unwrap.d.ts
/**
* Unwraps the wrapped schema.
*
* @param schema The schema to be unwrapped.
*
* @returns The unwrapped schema.
*/
declare function unwrap<TSchema extends ExactOptionalSchema<BaseSchema<unknown, unknown, BaseIssue<unknown>>, unknown> | ExactOptionalSchemaAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, unknown> | NonNullableSchema<BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<NonNullableIssue> | undefined> | NonNullableSchemaAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<NonNullableIssue> | undefined> | NonNullishSchema<BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<NonNullishIssue> | undefined> | NonNullishSchemaAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<NonNullishIssue> | undefined> | NonOptionalSchema<BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<NonOptionalIssue> | undefined> | NonOptionalSchemaAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<NonOptionalIssue> | undefined> | NullableSchema<BaseSchema<unknown, unknown, BaseIssue<unknown>>, unknown> | NullableSchemaAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, unknown> | NullishSchema<BaseSchema<unknown, unknown, BaseIssue<unknown>>, unknown> | NullishSchemaAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, unknown> | OptionalSchema<BaseSchema<unknown, unknown, BaseIssue<unknown>>, unknown> | OptionalSchemaAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, unknown> | UndefinedableSchema<BaseSchema<unknown, unknown, BaseIssue<unknown>>, unknown> | UndefinedableSchemaAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, unknown>>(schema: TSchema): TSchema["wrapped"];
//#endregion
//#region src/types/metadata.d.ts
/**
* Base metadata interface.
*/
interface BaseMetadata<TInput$1> {
  /**
  * The object kind.
  */
  readonly kind: "metadata";
  /**
  * The metadata type.
  */
  readonly type: string;
  /**
  * The metadata reference.
  */
  readonly reference: (...args: any[]) => BaseMetadata<any>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: TInput$1;
    readonly output: TInput$1;
    readonly issue: never;
  } | undefined;
}
/**
* Generic metadata type.
*/
type GenericMetadata<TInput$1 = any> = BaseMetadata<TInput$1>;
//#endregion
//#region src/types/dataset.d.ts
/**
* Unknown dataset interface.
*/
interface UnknownDataset {
  /**
  * Whether it's typed.
  */
  typed?: false;
  /**
  * The dataset value.
  */
  value: unknown;
  /**
  * The dataset issues.
  */
  issues?: undefined;
}
/**
* Success dataset interface.
*/
interface SuccessDataset<TValue$1> {
  /**
  * Whether it's typed.
  */
  typed: true;
  /**
  * The dataset value.
  */
  value: TValue$1;
  /**
  * The dataset issues.
  */
  issues?: undefined;
}
/**
* Partial dataset interface.
*/
interface PartialDataset<TValue$1, TIssue extends BaseIssue<unknown>> {
  /**
  * Whether it's typed.
  */
  typed: true;
  /**
  * The dataset value.
  */
  value: TValue$1;
  /**
  * The dataset issues.
  */
  issues: [TIssue, ...TIssue[]];
}
/**
* Failure dataset interface.
*/
interface FailureDataset<TIssue extends BaseIssue<unknown>> {
  /**
  * Whether it's typed.
  */
  typed: false;
  /**
  * The dataset value.
  */
  value: unknown;
  /**
  * The dataset issues.
  */
  issues: [TIssue, ...TIssue[]];
}
/**
* Output dataset type.
*/
type OutputDataset<TValue$1, TIssue extends BaseIssue<unknown>> = SuccessDataset<TValue$1> | PartialDataset<TValue$1, TIssue> | FailureDataset<TIssue>;
//#endregion
//#region src/types/standard.d.ts
/**
* The Standard Schema properties interface.
*/
interface StandardProps<TInput$1, TOutput$1> {
  /**
  * The version number of the standard.
  */
  readonly version: 1;
  /**
  * The vendor name of the schema library.
  */
  readonly vendor: "valibot";
  /**
  * Validates unknown input values.
  */
  readonly validate: (value: unknown) => StandardResult<TOutput$1> | Promise<StandardResult<TOutput$1>>;
  /**
  * Inferred types associated with the schema.
  */
  readonly types?: StandardTypes<TInput$1, TOutput$1> | undefined;
}
/**
* The result interface of the validate function.
*/
type StandardResult<TOutput$1> = StandardSuccessResult<TOutput$1> | StandardFailureResult;
/**
* The result interface if validation succeeds.
*/
interface StandardSuccessResult<TOutput$1> {
  /**
  * The typed output value.
  */
  readonly value: TOutput$1;
  /**
  * The non-existent issues.
  */
  readonly issues?: undefined;
}
/**
* The result interface if validation fails.
*/
interface StandardFailureResult {
  /**
  * The issues of failed validation.
  */
  readonly issues: readonly StandardIssue[];
}
/**
* The issue interface of the failure output.
*/
interface StandardIssue {
  /**
  * The error message of the issue.
  */
  readonly message: string;
  /**
  * The path of the issue, if any.
  */
  readonly path?: readonly (PropertyKey | StandardPathItem)[] | undefined;
}
/**
* The path item interface of the issue.
*/
interface StandardPathItem {
  /**
  * The key of the path item.
  */
  readonly key: PropertyKey;
}
/**
* The Standard Schema types interface.
*/
interface StandardTypes<TInput$1, TOutput$1> {
  /**
  * The input type of the schema.
  */
  readonly input: TInput$1;
  /**
  * The output type of the schema.
  */
  readonly output: TOutput$1;
}
//#endregion
//#region src/types/schema.d.ts
/**
* Base schema interface.
*/
interface BaseSchema<TInput$1, TOutput$1, TIssue extends BaseIssue<unknown>> {
  /**
  * The object kind.
  */
  readonly kind: "schema";
  /**
  * The schema type.
  */
  readonly type: string;
  /**
  * The schema reference.
  */
  readonly reference: (...args: any[]) => BaseSchema<unknown, unknown, BaseIssue<unknown>>;
  /**
  * The expected property.
  */
  readonly expects: string;
  /**
  * Whether it's async.
  */
  readonly async: false;
  /**
  * The Standard Schema properties.
  *
  * @internal
  */
  readonly "~standard": StandardProps<TInput$1, TOutput$1>;
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
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => OutputDataset<TOutput$1, TIssue>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: TInput$1;
    readonly output: TOutput$1;
    readonly issue: TIssue;
  } | undefined;
}
/**
* Base schema async interface.
*/
interface BaseSchemaAsync<TInput$1, TOutput$1, TIssue extends BaseIssue<unknown>> extends Omit<BaseSchema<TInput$1, TOutput$1, TIssue>, "reference" | "async" | "~run"> {
  /**
  * The schema reference.
  */
  readonly reference: (...args: any[]) => BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>;
  /**
  * Whether it's async.
  */
  readonly async: true;
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
  readonly "~run": (dataset: UnknownDataset, config: Config<BaseIssue<unknown>>) => Promise<OutputDataset<TOutput$1, TIssue>>;
}
/**
* Generic schema type.
*/
type GenericSchema<TInput$1 = unknown, TOutput$1 = TInput$1, TIssue extends BaseIssue<unknown> = BaseIssue<unknown>> = BaseSchema<TInput$1, TOutput$1, TIssue>;
/**
* Generic schema async type.
*/
type GenericSchemaAsync<TInput$1 = unknown, TOutput$1 = TInput$1, TIssue extends BaseIssue<unknown> = BaseIssue<unknown>> = BaseSchemaAsync<TInput$1, TOutput$1, TIssue>;
//#endregion
//#region src/types/transformation.d.ts
/**
* Base transformation interface.
*/
interface BaseTransformation<TInput$1, TOutput$1, TIssue extends BaseIssue<unknown>> {
  /**
  * The object kind.
  */
  readonly kind: "transformation";
  /**
  * The transformation type.
  */
  readonly type: string;
  /**
  * The transformation reference.
  */
  readonly reference: (...args: any[]) => BaseTransformation<any, any, BaseIssue<unknown>>;
  /**
  * Whether it's async.
  */
  readonly async: false;
  /**
  * Transforms known input values.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: SuccessDataset<TInput$1>, config: Config<BaseIssue<unknown>>) => OutputDataset<TOutput$1, BaseIssue<unknown> | TIssue>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: TInput$1;
    readonly output: TOutput$1;
    readonly issue: TIssue;
  } | undefined;
}
/**
* Base transformation async interface.
*/
interface BaseTransformationAsync<TInput$1, TOutput$1, TIssue extends BaseIssue<unknown>> extends Omit<BaseTransformation<TInput$1, TOutput$1, TIssue>, "reference" | "async" | "~run"> {
  /**
  * The transformation reference.
  */
  readonly reference: (...args: any[]) => BaseTransformation<any, any, BaseIssue<unknown>> | BaseTransformationAsync<any, any, BaseIssue<unknown>>;
  /**
  * Whether it's async.
  */
  readonly async: true;
  /**
  * Transforms known input values.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: SuccessDataset<TInput$1>, config: Config<BaseIssue<unknown>>) => Promise<OutputDataset<TOutput$1, BaseIssue<unknown> | TIssue>>;
}
/**
* Generic transformation type.
*/
type GenericTransformation<TInput$1 = any, TOutput$1 = TInput$1, TIssue extends BaseIssue<unknown> = BaseIssue<unknown>> = BaseTransformation<TInput$1, TOutput$1, TIssue>;
/**
* Generic transformation async type.
*/
type GenericTransformationAsync<TInput$1 = any, TOutput$1 = TInput$1, TIssue extends BaseIssue<unknown> = BaseIssue<unknown>> = BaseTransformationAsync<TInput$1, TOutput$1, TIssue>;
//#endregion
//#region src/types/validation.d.ts
/**
* Base validation interface.
*/
interface BaseValidation<TInput$1, TOutput$1, TIssue extends BaseIssue<unknown>> {
  /**
  * The object kind.
  */
  readonly kind: "validation";
  /**
  * The validation type.
  */
  readonly type: string;
  /**
  * The validation reference.
  */
  readonly reference: (...args: any[]) => BaseValidation<any, any, BaseIssue<unknown>>;
  /**
  * The expected property.
  */
  readonly expects: string | null;
  /**
  * Whether it's async.
  */
  readonly async: false;
  /**
  * Validates known input values.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: OutputDataset<TInput$1, BaseIssue<unknown>>, config: Config<BaseIssue<unknown>>) => OutputDataset<TOutput$1, BaseIssue<unknown> | TIssue>;
  /**
  * The input, output and issue type.
  *
  * @internal
  */
  readonly "~types"?: {
    readonly input: TInput$1;
    readonly output: TOutput$1;
    readonly issue: TIssue;
  } | undefined;
}
/**
* Base validation async interface.
*/
interface BaseValidationAsync<TInput$1, TOutput$1, TIssue extends BaseIssue<unknown>> extends Omit<BaseValidation<TInput$1, TOutput$1, TIssue>, "reference" | "async" | "~run"> {
  /**
  * The validation reference.
  */
  readonly reference: (...args: any[]) => BaseValidation<any, any, BaseIssue<unknown>> | BaseValidationAsync<any, any, BaseIssue<unknown>>;
  /**
  * Whether it's async.
  */
  readonly async: true;
  /**
  * Validates known input values.
  *
  * @param dataset The input dataset.
  * @param config The configuration.
  *
  * @returns The output dataset.
  *
  * @internal
  */
  readonly "~run": (dataset: OutputDataset<TInput$1, BaseIssue<unknown>>, config: Config<BaseIssue<unknown>>) => Promise<OutputDataset<TOutput$1, BaseIssue<unknown> | TIssue>>;
}
/**
* Generic validation type.
*/
type GenericValidation<TInput$1 = any, TOutput$1 = TInput$1, TIssue extends BaseIssue<unknown> = BaseIssue<unknown>> = BaseValidation<TInput$1, TOutput$1, TIssue>;
/**
* Generic validation async type.
*/
type GenericValidationAsync<TInput$1 = any, TOutput$1 = TInput$1, TIssue extends BaseIssue<unknown> = BaseIssue<unknown>> = BaseValidationAsync<TInput$1, TOutput$1, TIssue>;
//#endregion
//#region src/types/infer.d.ts
/**
* Infer input type.
*/
type InferInput<TItem$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> | BaseValidation<any, unknown, BaseIssue<unknown>> | BaseValidationAsync<any, unknown, BaseIssue<unknown>> | BaseTransformation<any, unknown, BaseIssue<unknown>> | BaseTransformationAsync<any, unknown, BaseIssue<unknown>> | BaseMetadata<any>> = NonNullable<TItem$1["~types"]>["input"];
/**
* Infer output type.
*/
type InferOutput<TItem$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> | BaseValidation<any, unknown, BaseIssue<unknown>> | BaseValidationAsync<any, unknown, BaseIssue<unknown>> | BaseTransformation<any, unknown, BaseIssue<unknown>> | BaseTransformationAsync<any, unknown, BaseIssue<unknown>> | BaseMetadata<any>> = NonNullable<TItem$1["~types"]>["output"];
/**
* Infer issue type.
*/
type InferIssue<TItem$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> | BaseValidation<any, unknown, BaseIssue<unknown>> | BaseValidationAsync<any, unknown, BaseIssue<unknown>> | BaseTransformation<any, unknown, BaseIssue<unknown>> | BaseTransformationAsync<any, unknown, BaseIssue<unknown>> | BaseMetadata<any>> = NonNullable<TItem$1["~types"]>["issue"];
//#endregion
//#region src/types/utils.d.ts
/**
* Checks if a type is `any`.
*/
type IsAny<Type> = 0 extends 1 & Type ? true : false;
/**
* Checks if a type is `never`.
*/
type IsNever<Type> = [Type] extends [never] ? true : false;
/**
* Extracts `null` from a type.
*/
type NonNullable$1<TValue$1> = TValue$1 extends null ? never : TValue$1;
/**
* Extracts `null` and `undefined` from a type.
*/
type NonNullish<TValue$1> = TValue$1 extends null | undefined ? never : TValue$1;
/**
* Extracts `undefined` from a type.
*/
type NonOptional<TValue$1> = TValue$1 extends undefined ? never : TValue$1;
/**
* Constructs a type that is maybe readonly.
*/
type MaybeReadonly<TValue$1> = TValue$1 | Readonly<TValue$1>;
/**
* Constructs a type that is deeply readonly.
*/
type DeepReadonly<TValue$1> = TValue$1 extends Record<string, unknown> | readonly unknown[] ? { readonly [TKey in keyof TValue$1]: DeepReadonly<TValue$1[TKey]> } : TValue$1;
/**
* Constructs a type that is maybe deeply readonly.
*/
type MaybeDeepReadonly<TValue$1> = TValue$1 | DeepReadonly<TValue$1>;
/**
* Constructs a type that is maybe a promise.
*/
type MaybePromise<TValue$1> = TValue$1 | Promise<TValue$1>;
/**
* Prettifies a type for better readability.
*
* Hint: This type has no effect and is only used so that TypeScript displays
* the final type in the preview instead of the utility types used.
*/
type Prettify<TObject> = { [TKey in keyof TObject]: TObject[TKey] } & {};
/**
* Marks specific keys as optional.
*/
type MarkOptional<TObject, TKeys extends keyof TObject> = { [TKey in keyof TObject]?: unknown } & Omit<TObject, TKeys> & Partial<Pick<TObject, TKeys>>;
/**
* Merges two objects. Overlapping entries from the second object overwrite
* properties from the first object.
*/
type Merge<TFirstObject, TSecondObject> = Omit<TFirstObject, keyof TFirstObject & keyof TSecondObject> & TSecondObject;
/**
* Extracts first tuple item.
*/
type FirstTupleItem<TTuple extends readonly [unknown, ...unknown[]]> = TTuple[0];
/**
* Extracts last tuple item.
*/
type LastTupleItem<TTuple extends readonly [unknown, ...unknown[]]> = TTuple[TTuple extends readonly [unknown, ...infer TRest] ? TRest["length"] : never];
/**
* Converts union to intersection type.
*/
type UnionToIntersect<TUnion> = (TUnion extends any ? (arg: TUnion) => void : never) extends ((arg: infer Intersect) => void) ? Intersect : never;
/**
* Converts union to tuple type using an accumulator.
*
* For more information: {@link https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-5.html#tail-recursion-elimination-on-conditional-types}
*/
type UnionToTupleHelper<TUnion, TResult extends unknown[]> = UnionToIntersect<TUnion extends never ? never : () => TUnion> extends (() => infer TLast) ? UnionToTupleHelper<Exclude<TUnion, TLast>, [TLast, ...TResult]> : TResult;
/**
* Converts union to tuple type.
*/
type UnionToTuple<TUnion> = UnionToTupleHelper<TUnion, []>;
//#endregion
//#region src/types/other.d.ts
/**
* Error message type.
*/
type ErrorMessage<TIssue extends BaseIssue<unknown>> = ((issue: TIssue) => string) | string;
/**
* Default type.
*/
type Default<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TInput$1 extends null | undefined> = MaybeDeepReadonly<InferInput<TWrapped$1> | TInput$1> | ((dataset?: UnknownDataset, config?: Config<InferIssue<TWrapped$1>>) => MaybeDeepReadonly<InferInput<TWrapped$1> | TInput$1>) | undefined;
/**
* Default async type.
*/
type DefaultAsync<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TInput$1 extends null | undefined> = MaybeDeepReadonly<InferInput<TWrapped$1> | TInput$1> | ((dataset?: UnknownDataset, config?: Config<InferIssue<TWrapped$1>>) => MaybePromise<MaybeDeepReadonly<InferInput<TWrapped$1> | TInput$1>>) | undefined;
/**
* Default value type.
*/
type DefaultValue<TDefault extends Default<BaseSchema<unknown, unknown, BaseIssue<unknown>>, null | undefined> | DefaultAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, null | undefined>> = TDefault extends DefaultAsync<infer TWrapped extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, infer TInput> ? TDefault extends ((dataset?: UnknownDataset, config?: Config<InferIssue<TWrapped>>) => MaybePromise<MaybeDeepReadonly<InferInput<TWrapped> | TInput>>) ? Awaited<ReturnType<TDefault>> : TDefault : never;
//#endregion
//#region src/types/object.d.ts
/**
* Optional entry schema type.
*/
type OptionalEntrySchema = ExactOptionalSchema<BaseSchema<unknown, unknown, BaseIssue<unknown>>, unknown> | NullishSchema<BaseSchema<unknown, unknown, BaseIssue<unknown>>, unknown> | OptionalSchema<BaseSchema<unknown, unknown, BaseIssue<unknown>>, unknown>;
/**
* Optional entry schema async type.
*/
type OptionalEntrySchemaAsync = ExactOptionalSchemaAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, unknown> | NullishSchemaAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, unknown> | OptionalSchemaAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, unknown>;
/**
* Object entries interface.
*/
interface ObjectEntries {
  [key: string]: BaseSchema<unknown, unknown, BaseIssue<unknown>> | SchemaWithFallback<BaseSchema<unknown, unknown, BaseIssue<unknown>>, unknown> | OptionalEntrySchema;
}
/**
* Object entries async interface.
*/
interface ObjectEntriesAsync {
  [key: string]: BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> | SchemaWithFallback<BaseSchema<unknown, unknown, BaseIssue<unknown>>, unknown> | SchemaWithFallbackAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, unknown> | OptionalEntrySchema | OptionalEntrySchemaAsync;
}
/**
* Object keys type.
*/
type ObjectKeys<TSchema extends LooseObjectSchema<ObjectEntries, ErrorMessage<LooseObjectIssue> | undefined> | LooseObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<LooseObjectIssue> | undefined> | ObjectSchema<ObjectEntries, ErrorMessage<ObjectIssue> | undefined> | ObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchema<ObjectEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | ObjectWithRestSchemaAsync<ObjectEntriesAsync, BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchema<ObjectEntries, ErrorMessage<StrictObjectIssue> | undefined> | StrictObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<StrictObjectIssue> | undefined>> = MaybeReadonly<[keyof TSchema["entries"], ...(keyof TSchema["entries"])[]]>;
/**
* Infer entries input type.
*/
type InferEntriesInput<TEntries$1 extends ObjectEntries | ObjectEntriesAsync> = { -readonly [TKey in keyof TEntries$1]: InferInput<TEntries$1[TKey]> };
/**
* Infer entries output type.
*/
type InferEntriesOutput<TEntries$1 extends ObjectEntries | ObjectEntriesAsync> = { -readonly [TKey in keyof TEntries$1]: InferOutput<TEntries$1[TKey]> };
/**
* Optional input keys type.
*/
type OptionalInputKeys<TEntries$1 extends ObjectEntries | ObjectEntriesAsync> = { [TKey in keyof TEntries$1]: TEntries$1[TKey] extends OptionalEntrySchema | OptionalEntrySchemaAsync ? TKey : never }[keyof TEntries$1];
/**
* Optional output keys type.
*/
type OptionalOutputKeys<TEntries$1 extends ObjectEntries | ObjectEntriesAsync> = { [TKey in keyof TEntries$1]: TEntries$1[TKey] extends OptionalEntrySchema | OptionalEntrySchemaAsync ? undefined extends TEntries$1[TKey]["default"] ? TKey : never : never }[keyof TEntries$1];
/**
* Input with question marks type.
*/
type InputWithQuestionMarks<TEntries$1 extends ObjectEntries | ObjectEntriesAsync, TObject extends InferEntriesInput<TEntries$1>> = MarkOptional<TObject, OptionalInputKeys<TEntries$1>>;
/**
* Output with question marks type.
*/
type OutputWithQuestionMarks<TEntries$1 extends ObjectEntries | ObjectEntriesAsync, TObject extends InferEntriesOutput<TEntries$1>> = MarkOptional<TObject, OptionalOutputKeys<TEntries$1>>;
/**
* Readonly output keys type.
*/
type ReadonlyOutputKeys<TEntries$1 extends ObjectEntries | ObjectEntriesAsync> = { [TKey in keyof TEntries$1]: TEntries$1[TKey] extends {
  readonly pipe: readonly unknown[];
} ? ReadonlyAction<any> extends TEntries$1[TKey]["pipe"][number] ? TKey : never : never }[keyof TEntries$1];
/**
* Output with readonly type.
*/
type OutputWithReadonly<TEntries$1 extends ObjectEntries | ObjectEntriesAsync, TObject extends OutputWithQuestionMarks<TEntries$1, InferEntriesOutput<TEntries$1>>> = ReadonlyOutputKeys<TEntries$1> extends never ? TObject : Readonly<TObject> & Pick<TObject, Exclude<keyof TObject, ReadonlyOutputKeys<TEntries$1>>>;
/**
* Infer object input type.
*/
type InferObjectInput<TEntries$1 extends ObjectEntries | ObjectEntriesAsync> = Prettify<InputWithQuestionMarks<TEntries$1, InferEntriesInput<TEntries$1>>>;
/**
* Infer object output type.
*/
type InferObjectOutput<TEntries$1 extends ObjectEntries | ObjectEntriesAsync> = Prettify<OutputWithReadonly<TEntries$1, OutputWithQuestionMarks<TEntries$1, InferEntriesOutput<TEntries$1>>>>;
/**
* Infer object issue type.
*/
type InferObjectIssue<TEntries$1 extends ObjectEntries | ObjectEntriesAsync> = InferIssue<TEntries$1[keyof TEntries$1]>;
//#endregion
//#region src/types/tuple.d.ts
/**
* Tuple items type.
*/
type TupleItems = MaybeReadonly<BaseSchema<unknown, unknown, BaseIssue<unknown>>[]>;
/**
* Tuple items async type.
*/
type TupleItemsAsync = MaybeReadonly<(BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>)[]>;
/**
* Infer tuple input type.
*/
type InferTupleInput<TItems$1 extends TupleItems | TupleItemsAsync> = { -readonly [TKey in keyof TItems$1]: InferInput<TItems$1[TKey]> };
/**
* Infer tuple output type.
*/
type InferTupleOutput<TItems$1 extends TupleItems | TupleItemsAsync> = { -readonly [TKey in keyof TItems$1]: InferOutput<TItems$1[TKey]> };
/**
* Infer tuple issue type.
*/
type InferTupleIssue<TItems$1 extends TupleItems | TupleItemsAsync> = InferIssue<TItems$1[number]>;
//#endregion
//#region src/types/issue.d.ts
/**
* Array path item interface.
*/
interface ArrayPathItem {
  /**
  * The path item type.
  */
  readonly type: "array";
  /**
  * The path item origin.
  */
  readonly origin: "value";
  /**
  * The path item input.
  */
  readonly input: MaybeReadonly<unknown[]>;
  /**
  * The path item key.
  */
  readonly key: number;
  /**
  * The path item value.
  */
  readonly value: unknown;
}
/**
* Map path item interface.
*/
interface MapPathItem {
  /**
  * The path item type.
  */
  readonly type: "map";
  /**
  * The path item origin.
  */
  readonly origin: "key" | "value";
  /**
  * The path item input.
  */
  readonly input: Map<unknown, unknown>;
  /**
  * The path item key.
  */
  readonly key: unknown;
  /**
  * The path item value.
  */
  readonly value: unknown;
}
/**
* Object path item interface.
*/
interface ObjectPathItem {
  /**
  * The path item type.
  */
  readonly type: "object";
  /**
  * The path item origin.
  */
  readonly origin: "key" | "value";
  /**
  * The path item input.
  */
  readonly input: Record<string, unknown>;
  /**
  * The path item key.
  */
  readonly key: string;
  /**
  * The path item value.
  */
  readonly value: unknown;
}
/**
* Set path item interface.
*/
interface SetPathItem {
  /**
  * The path item type.
  */
  readonly type: "set";
  /**
  * The path item origin.
  */
  readonly origin: "value";
  /**
  * The path item input.
  */
  readonly input: Set<unknown>;
  /**
  * The path item key.
  */
  readonly key: null;
  /**
  * The path item key.
  */
  readonly value: unknown;
}
/**
* Unknown path item interface.
*/
interface UnknownPathItem {
  /**
  * The path item type.
  */
  readonly type: "unknown";
  /**
  * The path item origin.
  */
  readonly origin: "key" | "value";
  /**
  * The path item input.
  */
  readonly input: unknown;
  /**
  * The path item key.
  */
  readonly key: unknown;
  /**
  * The path item value.
  */
  readonly value: unknown;
}
/**
* Issue path item type.
*/
type IssuePathItem = ArrayPathItem | MapPathItem | ObjectPathItem | SetPathItem | UnknownPathItem;
/**
* Base issue interface.
*/
interface BaseIssue<TInput$1> extends Config<BaseIssue<TInput$1>> {
  /**
  * The issue kind.
  */
  readonly kind: "schema" | "validation" | "transformation";
  /**
  * The issue type.
  */
  readonly type: string;
  /**
  * The raw input data.
  */
  readonly input: TInput$1;
  /**
  * The expected property.
  */
  readonly expected: string | null;
  /**
  * The received property.
  */
  readonly received: string;
  /**
  * The error message.
  */
  readonly message: string;
  /**
  * The input requirement.
  */
  readonly requirement?: unknown | undefined;
  /**
  * The issue path.
  */
  readonly path?: [IssuePathItem, ...IssuePathItem[]] | undefined;
  /**
  * The sub issues.
  */
  readonly issues?: [BaseIssue<TInput$1>, ...BaseIssue<TInput$1>[]] | undefined;
}
/**
* Generic issue type.
*/
type GenericIssue<TInput$1 = unknown> = BaseIssue<TInput$1>;
/**
* Dot path type.
*/
type DotPath<TKey$1 extends string | number | symbol, TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = TKey$1 extends string | number ? `${TKey$1}` | `${TKey$1}.${IssueDotPath<TSchema>}` : never;
/**
* Object path type.
*/
type ObjectPath<TEntries$1 extends ObjectEntries | ObjectEntriesAsync> = { [TKey in keyof TEntries$1]: DotPath<TKey, TEntries$1[TKey]> }[keyof TEntries$1];
/**
* Tuple keys type.
*/
type TupleKeys<TItems$1 extends TupleItems | TupleItemsAsync> = Exclude<keyof TItems$1, keyof []>;
/**
* Tuple path type.
*/
type TuplePath<TItems$1 extends TupleItems | TupleItemsAsync> = { [TKey in TupleKeys<TItems$1>]: TItems$1[TKey] extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> ? DotPath<TKey, TItems$1[TKey]> : never }[TupleKeys<TItems$1>];
/**
* Issue dot path type.
*/
type IssueDotPath<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = TSchema extends SchemaWithPipe<infer TPipe> ? IssueDotPath<FirstTupleItem<TPipe>> : TSchema extends SchemaWithPipeAsync<infer TPipe> ? IssueDotPath<FirstTupleItem<TPipe>> : TSchema extends ArraySchema<infer TItem, ErrorMessage<ArrayIssue> | undefined> ? DotPath<number, TItem> : TSchema extends ArraySchemaAsync<infer TItem, ErrorMessage<ArrayIssue> | undefined> ? DotPath<number, TItem> : TSchema extends IntersectSchema<infer TOptions, ErrorMessage<IntersectIssue> | undefined> | UnionSchema<infer TOptions, ErrorMessage<UnionIssue<BaseIssue<unknown>>> | undefined> | VariantSchema<string, infer TOptions, ErrorMessage<VariantIssue> | undefined> ? IssueDotPath<TOptions[number]> : TSchema extends IntersectSchemaAsync<infer TOptions, ErrorMessage<IntersectIssue> | undefined> | UnionSchemaAsync<infer TOptions, ErrorMessage<UnionIssue<BaseIssue<unknown>>> | undefined> | VariantSchemaAsync<string, infer TOptions, ErrorMessage<VariantIssue> | undefined> ? IssueDotPath<TOptions[number]> : TSchema extends MapSchema<infer TKey, infer TValue, ErrorMessage<MapIssue> | undefined> | RecordSchema<infer TKey, infer TValue, ErrorMessage<RecordIssue> | undefined> ? DotPath<InferInput<TKey>, TValue> : TSchema extends MapSchemaAsync<infer TKey, infer TValue, ErrorMessage<MapIssue> | undefined> | RecordSchemaAsync<infer TKey, infer TValue, ErrorMessage<RecordIssue> | undefined> ? DotPath<InferInput<TKey>, TValue> : TSchema extends LooseObjectSchema<infer TEntries, ErrorMessage<LooseObjectIssue> | undefined> | ObjectSchema<infer TEntries, ErrorMessage<ObjectIssue> | undefined> | StrictObjectSchema<infer TEntries, ErrorMessage<StrictObjectIssue> | undefined> ? ObjectPath<TEntries> : TSchema extends LooseObjectSchemaAsync<infer TEntries, ErrorMessage<LooseObjectIssue> | undefined> | ObjectSchemaAsync<infer TEntries, ErrorMessage<ObjectIssue> | undefined> | StrictObjectSchemaAsync<infer TEntries, ErrorMessage<StrictObjectIssue> | undefined> ? ObjectPath<TEntries> : TSchema extends ObjectWithRestSchema<ObjectEntries, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> ? string : TSchema extends ObjectWithRestSchemaAsync<ObjectEntriesAsync, BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> ? string : TSchema extends SetSchema<infer TValue, ErrorMessage<SetIssue> | undefined> ? DotPath<number, TValue> : TSchema extends SetSchemaAsync<infer TValue, ErrorMessage<SetIssue> | undefined> ? DotPath<number, TValue> : TSchema extends LooseTupleSchema<infer TItems, ErrorMessage<LooseTupleIssue> | undefined> | StrictTupleSchema<infer TItems, ErrorMessage<StrictTupleIssue> | undefined> | TupleSchema<infer TItems, ErrorMessage<TupleIssue> | undefined> ? TuplePath<TItems> : TSchema extends LooseTupleSchemaAsync<infer TItems, ErrorMessage<LooseTupleIssue> | undefined> | StrictTupleSchemaAsync<infer TItems, ErrorMessage<StrictTupleIssue> | undefined> | TupleSchemaAsync<infer TItems, ErrorMessage<TupleIssue> | undefined> ? TuplePath<TItems> : TSchema extends TupleWithRestSchema<infer TItems, infer TRest, ErrorMessage<TupleWithRestIssue> | undefined> ? TuplePath<TItems> | DotPath<number, TRest> : TSchema extends TupleWithRestSchemaAsync<infer TItems, infer TRest, ErrorMessage<TupleWithRestIssue> | undefined> ? TuplePath<TItems> | DotPath<number, TRest> : TSchema extends ExactOptionalSchema<infer TWrapped, Default<BaseSchema<unknown, unknown, BaseIssue<unknown>>, never>> | LazySchema<infer TWrapped> | NonNullableSchema<infer TWrapped, ErrorMessage<NonNullableIssue> | undefined> | NonNullishSchema<infer TWrapped, ErrorMessage<NonNullishIssue> | undefined> | NonOptionalSchema<infer TWrapped, ErrorMessage<NonOptionalIssue> | undefined> | NullableSchema<infer TWrapped, Default<BaseSchema<unknown, unknown, BaseIssue<unknown>>, null>> | NullishSchema<infer TWrapped, Default<BaseSchema<unknown, unknown, BaseIssue<unknown>>, null | undefined>> | OptionalSchema<infer TWrapped, Default<BaseSchema<unknown, unknown, BaseIssue<unknown>>, undefined>> | UndefinedableSchema<infer TWrapped, Default<BaseSchema<unknown, unknown, BaseIssue<unknown>>, undefined>> ? IssueDotPath<TWrapped> : TSchema extends ExactOptionalSchemaAsync<infer TWrapped, DefaultAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, never>> | LazySchemaAsync<infer TWrapped> | NonNullableSchemaAsync<infer TWrapped, ErrorMessage<NonNullableIssue> | undefined> | NonNullishSchemaAsync<infer TWrapped, ErrorMessage<NonNullishIssue> | undefined> | NonOptionalSchemaAsync<infer TWrapped, ErrorMessage<NonOptionalIssue> | undefined> | NullableSchemaAsync<infer TWrapped, DefaultAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, null>> | NullishSchemaAsync<infer TWrapped, DefaultAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, null | undefined>> | OptionalSchemaAsync<infer TWrapped, DefaultAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, undefined>> | UndefinedableSchemaAsync<infer TWrapped, DefaultAsync<BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, undefined>> ? IssueDotPath<TWrapped> : never;
//#endregion
//#region src/types/config.d.ts
/**
* Config interface.
*/
interface Config<TIssue extends BaseIssue<unknown>> {
  /**
  * The selected language.
  */
  readonly lang?: string | undefined;
  /**
  * The error message.
  */
  readonly message?: ErrorMessage<TIssue> | undefined;
  /**
  * Whether it should be aborted early.
  */
  readonly abortEarly?: boolean | undefined;
  /**
  * Whether a pipe should be aborted early.
  */
  readonly abortPipeEarly?: boolean | undefined;
}
//#endregion
//#region src/types/pipe.d.ts
/**
* Pipe action type.
*/
type PipeAction<TInput$1, TOutput$1, TIssue extends BaseIssue<unknown>> = BaseValidation<TInput$1, TOutput$1, TIssue> | BaseTransformation<TInput$1, TOutput$1, TIssue> | BaseMetadata<TInput$1>;
/**
* Pipe action async type.
*/
type PipeActionAsync<TInput$1, TOutput$1, TIssue extends BaseIssue<unknown>> = BaseValidationAsync<TInput$1, TOutput$1, TIssue> | BaseTransformationAsync<TInput$1, TOutput$1, TIssue>;
/**
* Pipe item type.
*/
type PipeItem<TInput$1, TOutput$1, TIssue extends BaseIssue<unknown>> = BaseSchema<TInput$1, TOutput$1, TIssue> | PipeAction<TInput$1, TOutput$1, TIssue>;
/**
* Pipe item async type.
*/
type PipeItemAsync<TInput$1, TOutput$1, TIssue extends BaseIssue<unknown>> = BaseSchemaAsync<TInput$1, TOutput$1, TIssue> | PipeActionAsync<TInput$1, TOutput$1, TIssue>;
/**
* Schema without pipe type.
*/
type SchemaWithoutPipe<TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = TSchema & {
  pipe?: never;
};
/**
* Generic pipe action type.
*/
type GenericPipeAction<TInput$1 = any, TOutput$1 = TInput$1, TIssue extends BaseIssue<unknown> = BaseIssue<unknown>> = PipeAction<TInput$1, TOutput$1, TIssue>;
/**
* Generic pipe action async type.
*/
type GenericPipeActionAsync<TInput$1 = any, TOutput$1 = TInput$1, TIssue extends BaseIssue<unknown> = BaseIssue<unknown>> = PipeActionAsync<TInput$1, TOutput$1, TIssue>;
/**
* Generic pipe item type.
*/
type GenericPipeItem<TInput$1 = any, TOutput$1 = TInput$1, TIssue extends BaseIssue<unknown> = BaseIssue<unknown>> = PipeItem<TInput$1, TOutput$1, TIssue>;
/**
* Generic pipe item async type.
*/
type GenericPipeItemAsync<TInput$1 = any, TOutput$1 = TInput$1, TIssue extends BaseIssue<unknown> = BaseIssue<unknown>> = PipeItemAsync<TInput$1, TOutput$1, TIssue>;
//#endregion
//#region src/schemas/any/any.d.ts
/**
* Any schema interface.
*/
interface AnySchema extends BaseSchema<any, any, never> {
  /**
  * The schema type.
  */
  readonly type: "any";
  /**
  * The schema reference.
  */
  readonly reference: typeof any;
  /**
  * The expected property.
  */
  readonly expects: "any";
}
/**
* Creates an any schema.
*
* Hint: This schema function exists only for completeness and is not
* recommended in practice. Instead, `unknown` should be used to accept
* unknown data.
*
* @returns An any schema.
*/
declare function any(): AnySchema;
//#endregion
//#region src/schemas/array/types.d.ts
/**
* Array issue interface.
*/
interface ArrayIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "array";
  /**
  * The expected property.
  */
  readonly expected: "Array";
}
//#endregion
//#region src/schemas/array/array.d.ts
/**
* Array schema interface.
*/
interface ArraySchema<TItem$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TMessage extends ErrorMessage<ArrayIssue> | undefined> extends BaseSchema<InferInput<TItem$1>[], InferOutput<TItem$1>[], ArrayIssue | InferIssue<TItem$1>> {
  /**
  * The schema type.
  */
  readonly type: "array";
  /**
  * The schema reference.
  */
  readonly reference: typeof array;
  /**
  * The expected property.
  */
  readonly expects: "Array";
  /**
  * The array item schema.
  */
  readonly item: TItem$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an array schema.
*
* @param item The item schema.
*
* @returns An array schema.
*/
declare function array<const TItem$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(item: TItem$1): ArraySchema<TItem$1, undefined>;
/**
* Creates an array schema.
*
* @param item The item schema.
* @param message The error message.
*
* @returns An array schema.
*/
declare function array<const TItem$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TMessage extends ErrorMessage<ArrayIssue> | undefined>(item: TItem$1, message: TMessage): ArraySchema<TItem$1, TMessage>;
//#endregion
//#region src/schemas/array/arrayAsync.d.ts
/**
* Array schema interface.
*/
interface ArraySchemaAsync<TItem$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TMessage extends ErrorMessage<ArrayIssue> | undefined> extends BaseSchemaAsync<InferInput<TItem$1>[], InferOutput<TItem$1>[], ArrayIssue | InferIssue<TItem$1>> {
  /**
  * The schema type.
  */
  readonly type: "array";
  /**
  * The schema reference.
  */
  readonly reference: typeof array | typeof arrayAsync;
  /**
  * The expected property.
  */
  readonly expects: "Array";
  /**
  * The array item schema.
  */
  readonly item: TItem$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an array schema.
*
* @param item The item schema.
*
* @returns An array schema.
*/
declare function arrayAsync<const TItem$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(item: TItem$1): ArraySchemaAsync<TItem$1, undefined>;
/**
* Creates an array schema.
*
* @param item The item schema.
* @param message The error message.
*
* @returns An array schema.
*/
declare function arrayAsync<const TItem$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TMessage extends ErrorMessage<ArrayIssue> | undefined>(item: TItem$1, message: TMessage): ArraySchemaAsync<TItem$1, TMessage>;
//#endregion
//#region src/schemas/bigint/bigint.d.ts
/**
* Bigint issue interface.
*/
interface BigintIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "bigint";
  /**
  * The expected property.
  */
  readonly expected: "bigint";
}
/**
* Bigint schema interface.
*/
interface BigintSchema<TMessage extends ErrorMessage<BigintIssue> | undefined> extends BaseSchema<bigint, bigint, BigintIssue> {
  /**
  * The schema type.
  */
  readonly type: "bigint";
  /**
  * The schema reference.
  */
  readonly reference: typeof bigint;
  /**
  * The expected property.
  */
  readonly expects: "bigint";
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a bigint schema.
*
* @returns A bigint schema.
*/
declare function bigint(): BigintSchema<undefined>;
/**
* Creates a bigint schema.
*
* @param message The error message.
*
* @returns A bigint schema.
*/
declare function bigint<const TMessage extends ErrorMessage<BigintIssue> | undefined>(message: TMessage): BigintSchema<TMessage>;
//#endregion
//#region src/schemas/blob/blob.d.ts
/**
* Blob issue interface.
*/
interface BlobIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "blob";
  /**
  * The expected property.
  */
  readonly expected: "Blob";
}
/**
* Blob schema interface.
*/
interface BlobSchema<TMessage extends ErrorMessage<BlobIssue> | undefined> extends BaseSchema<Blob, Blob, BlobIssue> {
  /**
  * The schema type.
  */
  readonly type: "blob";
  /**
  * The schema reference.
  */
  readonly reference: typeof blob;
  /**
  * The expected property.
  */
  readonly expects: "Blob";
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a blob schema.
*
* @returns A blob schema.
*/
declare function blob(): BlobSchema<undefined>;
/**
* Creates a blob schema.
*
* @param message The error message.
*
* @returns A blob schema.
*/
declare function blob<const TMessage extends ErrorMessage<BlobIssue> | undefined>(message: TMessage): BlobSchema<TMessage>;
//#endregion
//#region src/schemas/boolean/boolean.d.ts
/**
* Boolean issue interface.
*/
interface BooleanIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "boolean";
  /**
  * The expected property.
  */
  readonly expected: "boolean";
}
/**
* Boolean schema interface.
*/
interface BooleanSchema<TMessage extends ErrorMessage<BooleanIssue> | undefined> extends BaseSchema<boolean, boolean, BooleanIssue> {
  /**
  * The schema type.
  */
  readonly type: "boolean";
  /**
  * The schema reference.
  */
  readonly reference: typeof boolean;
  /**
  * The expected property.
  */
  readonly expects: "boolean";
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a boolean schema.
*
* @returns A boolean schema.
*/
declare function boolean(): BooleanSchema<undefined>;
/**
* Creates a boolean schema.
*
* @param message The error message.
*
* @returns A boolean schema.
*/
declare function boolean<const TMessage extends ErrorMessage<BooleanIssue> | undefined>(message: TMessage): BooleanSchema<TMessage>;
//#endregion
//#region src/schemas/custom/types.d.ts
/**
* Custom issue interface.
*/
interface CustomIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "custom";
  /**
  * The expected property.
  */
  readonly expected: "unknown";
}
//#endregion
//#region src/schemas/custom/custom.d.ts
/**
* Check type.
*/
type Check = (input: unknown) => boolean;
/**
* Custom schema interface.
*/
interface CustomSchema<TInput$1, TMessage extends ErrorMessage<CustomIssue> | undefined> extends BaseSchema<TInput$1, TInput$1, CustomIssue> {
  /**
  * The schema type.
  */
  readonly type: "custom";
  /**
  * The schema reference.
  */
  readonly reference: typeof custom;
  /**
  * The expected property.
  */
  readonly expects: "unknown";
  /**
  * The type check function.
  */
  readonly check: Check;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a custom schema.
*
* @param check The type check function.
*
* @returns A custom schema.
*/
declare function custom<TInput$1>(check: Check): CustomSchema<TInput$1, undefined>;
/**
* Creates a custom schema.
*
* @param check The type check function.
* @param message The error message.
*
* @returns A custom schema.
*/
declare function custom<TInput$1, const TMessage extends ErrorMessage<CustomIssue> | undefined = ErrorMessage<CustomIssue> | undefined>(check: Check, message: TMessage): CustomSchema<TInput$1, TMessage>;
//#endregion
//#region src/schemas/custom/customAsync.d.ts
/**
* Check async type.
*/
type CheckAsync = (input: unknown) => MaybePromise<boolean>;
/**
* Custom schema async interface.
*/
interface CustomSchemaAsync<TInput$1, TMessage extends ErrorMessage<CustomIssue> | undefined> extends BaseSchemaAsync<TInput$1, TInput$1, CustomIssue> {
  /**
  * The schema type.
  */
  readonly type: "custom";
  /**
  * The schema reference.
  */
  readonly reference: typeof custom | typeof customAsync;
  /**
  * The expected property.
  */
  readonly expects: "unknown";
  /**
  * The type check function.
  */
  readonly check: CheckAsync;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a custom schema.
*
* @param check The type check function.
*
* @returns A custom schema.
*/
declare function customAsync<TInput$1>(check: CheckAsync): CustomSchemaAsync<TInput$1, undefined>;
/**
* Creates a custom schema.
*
* @param check The type check function.
* @param message The error message.
*
* @returns A custom schema.
*/
declare function customAsync<TInput$1, const TMessage extends ErrorMessage<CustomIssue> | undefined = ErrorMessage<CustomIssue> | undefined>(check: CheckAsync, message: TMessage): CustomSchemaAsync<TInput$1, TMessage>;
//#endregion
//#region src/schemas/date/date.d.ts
/**
* Date issue interface.
*/
interface DateIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "date";
  /**
  * The expected property.
  */
  readonly expected: "Date";
}
/**
* Date schema interface.
*/
interface DateSchema<TMessage extends ErrorMessage<DateIssue> | undefined> extends BaseSchema<Date, Date, DateIssue> {
  /**
  * The schema type.
  */
  readonly type: "date";
  /**
  * The schema reference.
  */
  readonly reference: typeof date;
  /**
  * The expected property.
  */
  readonly expects: "Date";
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a date schema.
*
* @returns A date schema.
*/
declare function date(): DateSchema<undefined>;
/**
* Creates a date schema.
*
* @param message The error message.
*
* @returns A date schema.
*/
declare function date<const TMessage extends ErrorMessage<DateIssue> | undefined>(message: TMessage): DateSchema<TMessage>;
//#endregion
//#region src/schemas/enum/enum.d.ts
/**
* Enum interface.
*/
interface Enum {
  [key: string]: string | number;
}
/**
* Enum values type.
*/
type EnumValues<TEnum extends Enum> = { [TKey in keyof TEnum]: TKey extends number ? TEnum[TKey] extends string ? TEnum[TEnum[TKey]] extends TKey ? never : TEnum[TKey] : TEnum[TKey] : TKey extends "NaN" | "Infinity" | "-Infinity" ? TEnum[TKey] extends string ? TEnum[TEnum[TKey]] extends number ? never : TEnum[TKey] : TEnum[TKey] : TKey extends `+${number}` ? TEnum[TKey] : TKey extends `${infer TNumber extends number}` ? TEnum[TKey] extends string ? TEnum[TEnum[TKey]] extends TNumber ? never : TEnum[TKey] : TEnum[TKey] : TEnum[TKey] }[keyof TEnum];
/**
* Enum issue interface.
*/
interface EnumIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "enum";
  /**
  * The expected property.
  */
  readonly expected: string;
}
/**
* Enum schema interface.
*/
interface EnumSchema<TEnum extends Enum, TMessage extends ErrorMessage<EnumIssue> | undefined> extends BaseSchema<EnumValues<TEnum>, EnumValues<TEnum>, EnumIssue> {
  /**
  * The schema type.
  */
  readonly type: "enum";
  /**
  * The schema reference.
  */
  readonly reference: typeof enum_;
  /**
  * The enum object.
  */
  readonly enum: TEnum;
  /**
  * The enum options.
  */
  readonly options: EnumValues<TEnum>[];
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an enum schema.
*
* @param enum__ The enum object.
*
* @returns An enum schema.
*/
declare function enum_<const TEnum extends Enum>(enum__: TEnum): EnumSchema<TEnum, undefined>;
/**
* Creates an enum schema.
*
* @param enum__ The enum object.
* @param message The error message.
*
* @returns An enum schema.
*/
declare function enum_<const TEnum extends Enum, const TMessage extends ErrorMessage<EnumIssue> | undefined>(enum__: TEnum, message: TMessage): EnumSchema<TEnum, TMessage>;
//#endregion
//#region src/schemas/exactOptional/exactOptional.d.ts
/**
* Exact optional schema interface.
*/
interface ExactOptionalSchema<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TDefault extends Default<TWrapped$1, never>> extends BaseSchema<InferInput<TWrapped$1>, InferOutput<TWrapped$1>, InferIssue<TWrapped$1>> {
  /**
  * The schema type.
  */
  readonly type: "exact_optional";
  /**
  * The schema reference.
  */
  readonly reference: typeof exactOptional;
  /**
  * The expected property.
  */
  readonly expects: TWrapped$1["expects"];
  /**
  * The wrapped schema.
  */
  readonly wrapped: TWrapped$1;
  /**
  * The default value.
  */
  readonly default: TDefault;
}
/**
* Creates an exact optional schema.
*
* @param wrapped The wrapped schema.
*
* @returns An exact optional schema.
*/
declare function exactOptional<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(wrapped: TWrapped$1): ExactOptionalSchema<TWrapped$1, undefined>;
/**
* Creates an exact optional schema.
*
* @param wrapped The wrapped schema.
* @param default_ The default value.
*
* @returns An exact optional schema.
*/
declare function exactOptional<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TDefault extends Default<TWrapped$1, never>>(wrapped: TWrapped$1, default_: TDefault): ExactOptionalSchema<TWrapped$1, TDefault>;
//#endregion
//#region src/schemas/exactOptional/exactOptionalAsync.d.ts
/**
* Exact optional schema async interface.
*/
interface ExactOptionalSchemaAsync<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TDefault extends DefaultAsync<TWrapped$1, never>> extends BaseSchemaAsync<InferInput<TWrapped$1>, InferOutput<TWrapped$1>, InferIssue<TWrapped$1>> {
  /**
  * The schema type.
  */
  readonly type: "exact_optional";
  /**
  * The schema reference.
  */
  readonly reference: typeof exactOptional | typeof exactOptionalAsync;
  /**
  * The expected property.
  */
  readonly expects: TWrapped$1["expects"];
  /**
  * The wrapped schema.
  */
  readonly wrapped: TWrapped$1;
  /**
  * The default value.
  */
  readonly default: TDefault;
}
/**
* Creates an exact optional schema.
*
* @param wrapped The wrapped schema.
*
* @returns An exact optional schema.
*/
declare function exactOptionalAsync<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(wrapped: TWrapped$1): ExactOptionalSchemaAsync<TWrapped$1, undefined>;
/**
* Creates an exact optional schema.
*
* @param wrapped The wrapped schema.
* @param default_ The default value.
*
* @returns An exact optional schema.
*/
declare function exactOptionalAsync<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TDefault extends DefaultAsync<TWrapped$1, never>>(wrapped: TWrapped$1, default_: TDefault): ExactOptionalSchemaAsync<TWrapped$1, TDefault>;
//#endregion
//#region src/schemas/file/file.d.ts
/**
* File issue interface.
*/
interface FileIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "file";
  /**
  * The expected property.
  */
  readonly expected: "File";
}
/**
* File schema interface.
*/
interface FileSchema<TMessage extends ErrorMessage<FileIssue> | undefined> extends BaseSchema<File, File, FileIssue> {
  /**
  * The schema type.
  */
  readonly type: "file";
  /**
  * The schema reference.
  */
  readonly reference: typeof file;
  /**
  * The expected property.
  */
  readonly expects: "File";
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a file schema.
*
* @returns A file schema.
*/
declare function file(): FileSchema<undefined>;
/**
* Creates a file schema.
*
* @param message The error message.
*
* @returns A file schema.
*/
declare function file<const TMessage extends ErrorMessage<FileIssue> | undefined>(message: TMessage): FileSchema<TMessage>;
//#endregion
//#region src/schemas/function/function.d.ts
/**
* Function issue interface.
*/
interface FunctionIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "function";
  /**
  * The expected property.
  */
  readonly expected: "Function";
}
/**
* Function schema interface.
*/
interface FunctionSchema<TMessage extends ErrorMessage<FunctionIssue> | undefined> extends BaseSchema<(...args: unknown[]) => unknown, (...args: unknown[]) => unknown, FunctionIssue> {
  /**
  * The schema type.
  */
  readonly type: "function";
  /**
  * The schema reference.
  */
  readonly reference: typeof function_;
  /**
  * The expected property.
  */
  readonly expects: "Function";
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a function schema.
*
* @returns A function schema.
*/
declare function function_(): FunctionSchema<undefined>;
/**
* Creates a function schema.
*
* @param message The error message.
*
* @returns A function schema.
*/
declare function function_<const TMessage extends ErrorMessage<FunctionIssue> | undefined>(message: TMessage): FunctionSchema<TMessage>;
//#endregion
//#region src/schemas/instance/instance.d.ts
/**
* Class type.
*/
type Class = new (...args: any[]) => any;
/**
* Instance issue interface.
*/
interface InstanceIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "instance";
  /**
  * The expected property.
  */
  readonly expected: string;
}
/**
* Instance schema interface.
*/
interface InstanceSchema<TClass extends Class, TMessage extends ErrorMessage<InstanceIssue> | undefined> extends BaseSchema<InstanceType<TClass>, InstanceType<TClass>, InstanceIssue> {
  /**
  * The schema type.
  */
  readonly type: "instance";
  /**
  * The schema reference.
  */
  readonly reference: typeof instance;
  /**
  * The class of the instance.
  */
  readonly class: TClass;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an instance schema.
*
* @param class_ The class of the instance.
*
* @returns An instance schema.
*/
declare function instance<TClass extends Class>(class_: TClass): InstanceSchema<TClass, undefined>;
/**
* Creates an instance schema.
*
* @param class_ The class of the instance.
* @param message The error message.
*
* @returns An instance schema.
*/
declare function instance<TClass extends Class, const TMessage extends ErrorMessage<InstanceIssue> | undefined>(class_: TClass, message: TMessage): InstanceSchema<TClass, TMessage>;
//#endregion
//#region src/schemas/intersect/types.d.ts
/**
* Intersect issue interface.
*/
interface IntersectIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "intersect";
  /**
  * The expected property.
  */
  readonly expected: string;
}
/**
* Intersect options type.
*/
type IntersectOptions = MaybeReadonly<BaseSchema<unknown, unknown, BaseIssue<unknown>>[]>;
/**
* Intersect options async type.
*/
type IntersectOptionsAsync = MaybeReadonly<(BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>)[]>;
/**
* Infer option type.
*/
type InferOption<TInput$1, TOutput$1> = BaseSchema<TInput$1, TOutput$1, BaseIssue<unknown>> | BaseSchemaAsync<TInput$1, TOutput$1, BaseIssue<unknown>>;
/**
* Infer intersect input type.
*/
type InferIntersectInput<TOptions$1 extends IntersectOptions | IntersectOptionsAsync> = TOptions$1 extends readonly [InferOption<infer TInput, unknown>, ...infer TRest] ? TRest extends readonly [InferOption<unknown, unknown>, ...InferOption<unknown, unknown>[]] ? TInput & InferIntersectInput<TRest> : TInput : IsNever<TOptions$1[number]> extends true ? never : UnionToIntersect<InferInput<TOptions$1[number]>>;
/**
* Infer intersect output type.
*/
type InferIntersectOutput<TOptions$1 extends IntersectOptions | IntersectOptionsAsync> = TOptions$1 extends readonly [InferOption<unknown, infer TOutput>, ...infer TRest] ? TRest extends readonly [InferOption<unknown, unknown>, ...InferOption<unknown, unknown>[]] ? TOutput & InferIntersectOutput<TRest> : TOutput : IsNever<TOptions$1[number]> extends true ? never : UnionToIntersect<InferOutput<TOptions$1[number]>>;
//#endregion
//#region src/schemas/intersect/intersect.d.ts
/**
* Intersect schema interface.
*/
interface IntersectSchema<TOptions$1 extends IntersectOptions, TMessage extends ErrorMessage<IntersectIssue> | undefined> extends BaseSchema<InferIntersectInput<TOptions$1>, InferIntersectOutput<TOptions$1>, IntersectIssue | InferIssue<TOptions$1[number]>> {
  /**
  * The schema type.
  */
  readonly type: "intersect";
  /**
  * The schema reference.
  */
  readonly reference: typeof intersect;
  /**
  * The intersect options.
  */
  readonly options: TOptions$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an intersect schema.
*
* @param options The intersect options.
*
* @returns An intersect schema.
*/
declare function intersect<const TOptions$1 extends IntersectOptions>(options: TOptions$1): IntersectSchema<TOptions$1, undefined>;
/**
* Creates an intersect schema.
*
* @param options The intersect options.
* @param message The error message.
*
* @returns An intersect schema.
*/
declare function intersect<const TOptions$1 extends IntersectOptions, const TMessage extends ErrorMessage<IntersectIssue> | undefined>(options: TOptions$1, message: TMessage): IntersectSchema<TOptions$1, TMessage>;
//#endregion
//#region src/schemas/intersect/intersectAsync.d.ts
/**
* Intersect schema async interface.
*/
interface IntersectSchemaAsync<TOptions$1 extends IntersectOptionsAsync, TMessage extends ErrorMessage<IntersectIssue> | undefined> extends BaseSchemaAsync<InferIntersectInput<TOptions$1>, InferIntersectOutput<TOptions$1>, IntersectIssue | InferIssue<TOptions$1[number]>> {
  /**
  * The schema type.
  */
  readonly type: "intersect";
  /**
  * The schema reference.
  */
  readonly reference: typeof intersect | typeof intersectAsync;
  /**
  * The intersect options.
  */
  readonly options: TOptions$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an intersect schema.
*
* @param options The intersect options.
*
* @returns An intersect schema.
*/
declare function intersectAsync<const TOptions$1 extends IntersectOptionsAsync>(options: TOptions$1): IntersectSchemaAsync<TOptions$1, undefined>;
/**
* Creates an intersect schema.
*
* @param options The intersect options.
* @param message The error message.
*
* @returns An intersect schema.
*/
declare function intersectAsync<const TOptions$1 extends IntersectOptionsAsync, const TMessage extends ErrorMessage<IntersectIssue> | undefined>(options: TOptions$1, message: TMessage): IntersectSchemaAsync<TOptions$1, TMessage>;
//#endregion
//#region src/schemas/lazy/lazy.d.ts
/**
* Lazy schema interface.
*/
interface LazySchema<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>> extends BaseSchema<InferInput<TWrapped$1>, InferOutput<TWrapped$1>, InferIssue<TWrapped$1>> {
  /**
  * The schema type.
  */
  readonly type: "lazy";
  /**
  * The schema reference.
  */
  readonly reference: typeof lazy;
  /**
  * The expected property.
  */
  readonly expects: "unknown";
  /**
  * The schema getter.
  */
  readonly getter: (input: unknown) => TWrapped$1;
}
/**
* Creates a lazy schema.
*
* @param getter The schema getter.
*
* @returns A lazy schema.
*/
declare function lazy<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(getter: (input: unknown) => TWrapped$1): LazySchema<TWrapped$1>;
//#endregion
//#region src/schemas/lazy/lazyAsync.d.ts
/**
* Lazy schema async interface.
*/
interface LazySchemaAsync<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> extends BaseSchemaAsync<InferInput<TWrapped$1>, InferOutput<TWrapped$1>, InferIssue<TWrapped$1>> {
  /**
  * The schema type.
  */
  readonly type: "lazy";
  /**
  * The schema reference.
  */
  readonly reference: typeof lazy | typeof lazyAsync;
  /**
  * The expected property.
  */
  readonly expects: "unknown";
  /**
  * The schema getter.
  */
  readonly getter: (input: unknown) => MaybePromise<TWrapped$1>;
}
/**
* Creates a lazy schema.
*
* @param getter The schema getter.
*
* @returns A lazy schema.
*/
declare function lazyAsync<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(getter: (input: unknown) => MaybePromise<TWrapped$1>): LazySchemaAsync<TWrapped$1>;
//#endregion
//#region src/schemas/literal/literal.d.ts
/**
* Literal type.
*/
type Literal = bigint | boolean | number | string | symbol;
/**
* Literal issue interface.
*/
interface LiteralIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "literal";
  /**
  * The expected property.
  */
  readonly expected: string;
}
/**
* Literal schema interface.
*/
interface LiteralSchema<TLiteral extends Literal, TMessage extends ErrorMessage<LiteralIssue> | undefined> extends BaseSchema<TLiteral, TLiteral, LiteralIssue> {
  /**
  * The schema type.
  */
  readonly type: "literal";
  /**
  * The schema reference.
  */
  readonly reference: typeof literal;
  /**
  * The literal value.
  */
  readonly literal: TLiteral;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a literal schema.
*
* @param literal_ The literal value.
*
* @returns A literal schema.
*/
declare function literal<const TLiteral extends Literal>(literal_: TLiteral): LiteralSchema<TLiteral, undefined>;
/**
* Creates a literal schema.
*
* @param literal_ The literal value.
* @param message The error message.
*
* @returns A literal schema.
*/
declare function literal<const TLiteral extends Literal, const TMessage extends ErrorMessage<LiteralIssue> | undefined>(literal_: TLiteral, message: TMessage): LiteralSchema<TLiteral, TMessage>;
//#endregion
//#region src/schemas/looseObject/types.d.ts
/**
* Loose object issue interface.
*/
interface LooseObjectIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "loose_object";
  /**
  * The expected property.
  */
  readonly expected: "Object" | `"${string}"`;
}
//#endregion
//#region src/schemas/looseObject/looseObject.d.ts
/**
* Loose object schema interface.
*/
interface LooseObjectSchema<TEntries$1 extends ObjectEntries, TMessage extends ErrorMessage<LooseObjectIssue> | undefined> extends BaseSchema<InferObjectInput<TEntries$1> & {
  [key: string]: unknown;
}, InferObjectOutput<TEntries$1> & {
  [key: string]: unknown;
}, LooseObjectIssue | InferObjectIssue<TEntries$1>> {
  /**
  * The schema type.
  */
  readonly type: "loose_object";
  /**
  * The schema reference.
  */
  readonly reference: typeof looseObject;
  /**
  * The expected property.
  */
  readonly expects: "Object";
  /**
  * The entries schema.
  */
  readonly entries: TEntries$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a loose object schema.
*
* @param entries The entries schema.
*
* @returns A loose object schema.
*/
declare function looseObject<const TEntries$1 extends ObjectEntries>(entries: TEntries$1): LooseObjectSchema<TEntries$1, undefined>;
/**
* Creates a loose object schema.
*
* @param entries The entries schema.
* @param message The error message.
*
* @returns A loose object schema.
*/
declare function looseObject<const TEntries$1 extends ObjectEntries, const TMessage extends ErrorMessage<LooseObjectIssue> | undefined>(entries: TEntries$1, message: TMessage): LooseObjectSchema<TEntries$1, TMessage>;
//#endregion
//#region src/schemas/looseObject/looseObjectAsync.d.ts
/**
* Object schema async interface.
*/
interface LooseObjectSchemaAsync<TEntries$1 extends ObjectEntriesAsync, TMessage extends ErrorMessage<LooseObjectIssue> | undefined> extends BaseSchemaAsync<InferObjectInput<TEntries$1> & {
  [key: string]: unknown;
}, InferObjectOutput<TEntries$1> & {
  [key: string]: unknown;
}, LooseObjectIssue | InferObjectIssue<TEntries$1>> {
  /**
  * The schema type.
  */
  readonly type: "loose_object";
  /**
  * The schema reference.
  */
  readonly reference: typeof looseObject | typeof looseObjectAsync;
  /**
  * The expected property.
  */
  readonly expects: "Object";
  /**
  * The entries schema.
  */
  readonly entries: TEntries$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a loose object schema.
*
* @param entries The entries schema.
*
* @returns A loose object schema.
*/
declare function looseObjectAsync<const TEntries$1 extends ObjectEntriesAsync>(entries: TEntries$1): LooseObjectSchemaAsync<TEntries$1, undefined>;
/**
* Creates a loose object schema.
*
* @param entries The entries schema.
* @param message The error message.
*
* @returns A loose object schema.
*/
declare function looseObjectAsync<const TEntries$1 extends ObjectEntriesAsync, const TMessage extends ErrorMessage<LooseObjectIssue> | undefined>(entries: TEntries$1, message: TMessage): LooseObjectSchemaAsync<TEntries$1, TMessage>;
//#endregion
//#region src/schemas/looseTuple/types.d.ts
/**
* Loose tuple issue interface.
*/
interface LooseTupleIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "loose_tuple";
  /**
  * The expected property.
  */
  readonly expected: "Array";
}
//#endregion
//#region src/schemas/looseTuple/looseTuple.d.ts
/**
* Loose tuple schema interface.
*/
interface LooseTupleSchema<TItems$1 extends TupleItems, TMessage extends ErrorMessage<LooseTupleIssue> | undefined> extends BaseSchema<[...InferTupleInput<TItems$1>, ...unknown[]], [...InferTupleOutput<TItems$1>, ...unknown[]], LooseTupleIssue | InferTupleIssue<TItems$1>> {
  /**
  * The schema type.
  */
  readonly type: "loose_tuple";
  /**
  * The schema reference.
  */
  readonly reference: typeof looseTuple;
  /**
  * The expected property.
  */
  readonly expects: "Array";
  /**
  * The items schema.
  */
  readonly items: TItems$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a loose tuple schema.
*
* @param items The items schema.
*
* @returns A loose tuple schema.
*/
declare function looseTuple<const TItems$1 extends TupleItems>(items: TItems$1): LooseTupleSchema<TItems$1, undefined>;
/**
* Creates a loose tuple schema.
*
* @param items The items schema.
* @param message The error message.
*
* @returns A loose tuple schema.
*/
declare function looseTuple<const TItems$1 extends TupleItems, const TMessage extends ErrorMessage<LooseTupleIssue> | undefined>(items: TItems$1, message: TMessage): LooseTupleSchema<TItems$1, TMessage>;
//#endregion
//#region src/schemas/looseTuple/looseTupleAsync.d.ts
/**
* Loose tuple schema async interface.
*/
interface LooseTupleSchemaAsync<TItems$1 extends TupleItemsAsync, TMessage extends ErrorMessage<LooseTupleIssue> | undefined> extends BaseSchemaAsync<[...InferTupleInput<TItems$1>, ...unknown[]], [...InferTupleOutput<TItems$1>, ...unknown[]], LooseTupleIssue | InferTupleIssue<TItems$1>> {
  /**
  * The schema type.
  */
  readonly type: "loose_tuple";
  /**
  * The schema reference.
  */
  readonly reference: typeof looseTuple | typeof looseTupleAsync;
  /**
  * The expected property.
  */
  readonly expects: "Array";
  /**
  * The items schema.
  */
  readonly items: TItems$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a loose tuple schema.
*
* @param items The items schema.
*
* @returns A loose tuple schema.
*/
declare function looseTupleAsync<const TItems$1 extends TupleItemsAsync>(items: TItems$1): LooseTupleSchemaAsync<TItems$1, undefined>;
/**
* Creates a loose tuple schema.
*
* @param items The items schema.
* @param message The error message.
*
* @returns A loose tuple schema.
*/
declare function looseTupleAsync<const TItems$1 extends TupleItemsAsync, const TMessage extends ErrorMessage<LooseTupleIssue> | undefined>(items: TItems$1, message: TMessage): LooseTupleSchemaAsync<TItems$1, TMessage>;
//#endregion
//#region src/schemas/map/types.d.ts
/**
* Map issue interface.
*/
interface MapIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "map";
  /**
  * The expected property.
  */
  readonly expected: "Map";
}
/**
* Infer map input type.
*/
type InferMapInput<TKey$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = Map<InferInput<TKey$1>, InferInput<TValue$1>>;
/**
* Infer map output type.
*/
type InferMapOutput<TKey$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = Map<InferOutput<TKey$1>, InferOutput<TValue$1>>;
//#endregion
//#region src/schemas/map/map.d.ts
/**
* Map schema interface.
*/
interface MapSchema<TKey$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TMessage extends ErrorMessage<MapIssue> | undefined> extends BaseSchema<InferMapInput<TKey$1, TValue$1>, InferMapOutput<TKey$1, TValue$1>, MapIssue | InferIssue<TKey$1> | InferIssue<TValue$1>> {
  /**
  * The schema type.
  */
  readonly type: "map";
  /**
  * The schema reference.
  */
  readonly reference: typeof map;
  /**
  * The expected property.
  */
  readonly expects: "Map";
  /**
  * The map key schema.
  */
  readonly key: TKey$1;
  /**
  * The map value schema.
  */
  readonly value: TValue$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a map schema.
*
* @param key The key schema.
* @param value The value schema.
*
* @returns A map schema.
*/
declare function map<const TKey$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(key: TKey$1, value: TValue$1): MapSchema<TKey$1, TValue$1, undefined>;
/**
* Creates a map schema.
*
* @param key The key schema.
* @param value The value schema.
* @param message The error message.
*
* @returns A map schema.
*/
declare function map<const TKey$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TMessage extends ErrorMessage<MapIssue> | undefined>(key: TKey$1, value: TValue$1, message: TMessage): MapSchema<TKey$1, TValue$1, TMessage>;
//#endregion
//#region src/schemas/map/mapAsync.d.ts
/**
* Map schema async interface.
*/
interface MapSchemaAsync<TKey$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TMessage extends ErrorMessage<MapIssue> | undefined> extends BaseSchemaAsync<InferMapInput<TKey$1, TValue$1>, InferMapOutput<TKey$1, TValue$1>, MapIssue | InferIssue<TKey$1> | InferIssue<TValue$1>> {
  /**
  * The schema type.
  */
  readonly type: "map";
  /**
  * The schema reference.
  */
  readonly reference: typeof map | typeof mapAsync;
  /**
  * The expected property.
  */
  readonly expects: "Map";
  /**
  * The map key schema.
  */
  readonly key: TKey$1;
  /**
  * The map value schema.
  */
  readonly value: TValue$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a map schema.
*
* @param key The key schema.
* @param value The value schema.
*
* @returns A map schema.
*/
declare function mapAsync<const TKey$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(key: TKey$1, value: TValue$1): MapSchemaAsync<TKey$1, TValue$1, undefined>;
/**
* Creates a map schema.
*
* @param key The key schema.
* @param value The value schema.
* @param message The error message.
*
* @returns A map schema.
*/
declare function mapAsync<const TKey$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TMessage extends ErrorMessage<MapIssue> | undefined>(key: TKey$1, value: TValue$1, message: TMessage): MapSchemaAsync<TKey$1, TValue$1, TMessage>;
//#endregion
//#region src/schemas/nan/nan.d.ts
/**
* NaN issue interface.
*/
interface NanIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "nan";
  /**
  * The expected property.
  */
  readonly expected: "NaN";
}
/**
* NaN schema interface.
*/
interface NanSchema<TMessage extends ErrorMessage<NanIssue> | undefined> extends BaseSchema<number, number, NanIssue> {
  /**
  * The schema type.
  */
  readonly type: "nan";
  /**
  * The schema reference.
  */
  readonly reference: typeof nan;
  /**
  * The expected property.
  */
  readonly expects: "NaN";
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a NaN schema.
*
* @returns A NaN schema.
*/
declare function nan(): NanSchema<undefined>;
/**
* Creates a NaN schema.
*
* @param message The error message.
*
* @returns A NaN schema.
*/
declare function nan<const TMessage extends ErrorMessage<NanIssue> | undefined>(message: TMessage): NanSchema<TMessage>;
//#endregion
//#region src/schemas/never/never.d.ts
/**
* Never issue interface.
*/
interface NeverIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "never";
  /**
  * The expected property.
  */
  readonly expected: "never";
}
/**
* Never schema interface.
*/
interface NeverSchema<TMessage extends ErrorMessage<NeverIssue> | undefined> extends BaseSchema<never, never, NeverIssue> {
  /**
  * The schema type.
  */
  readonly type: "never";
  /**
  * The schema reference.
  */
  readonly reference: typeof never;
  /**
  * The expected property.
  */
  readonly expects: "never";
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a never schema.
*
* @returns A never schema.
*/
declare function never(): NeverSchema<undefined>;
/**
* Creates a never schema.
*
* @param message The error message.
*
* @returns A never schema.
*/
declare function never<const TMessage extends ErrorMessage<NeverIssue> | undefined>(message: TMessage): NeverSchema<TMessage>;
//#endregion
//#region src/schemas/union/types.d.ts
/**
* Union issue interface.
*/
interface UnionIssue<TSubIssue extends BaseIssue<unknown>> extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "union";
  /**
  * The expected property.
  */
  readonly expected: string;
  /**
  * The sub issues.
  */
  readonly issues?: [TSubIssue, ...TSubIssue[]];
}
//#endregion
//#region src/schemas/union/union.d.ts
/**
* Union options type.
*/
type UnionOptions = MaybeReadonly<BaseSchema<unknown, unknown, BaseIssue<unknown>>[]>;
/**
* Union schema interface.
*/
interface UnionSchema<TOptions$1 extends UnionOptions, TMessage extends ErrorMessage<UnionIssue<InferIssue<TOptions$1[number]>>> | undefined> extends BaseSchema<InferInput<TOptions$1[number]>, InferOutput<TOptions$1[number]>, UnionIssue<InferIssue<TOptions$1[number]>> | InferIssue<TOptions$1[number]>> {
  /**
  * The schema type.
  */
  readonly type: "union";
  /**
  * The schema reference.
  */
  readonly reference: typeof union;
  /**
  * The union options.
  */
  readonly options: TOptions$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an union schema.
*
* @param options The union options.
*
* @returns An union schema.
*/
declare function union<const TOptions$1 extends UnionOptions>(options: TOptions$1): UnionSchema<TOptions$1, undefined>;
/**
* Creates an union schema.
*
* @param options The union options.
* @param message The error message.
*
* @returns An union schema.
*/
declare function union<const TOptions$1 extends UnionOptions, const TMessage extends ErrorMessage<UnionIssue<InferIssue<TOptions$1[number]>>> | undefined>(options: TOptions$1, message: TMessage): UnionSchema<TOptions$1, TMessage>;
//#endregion
//#region src/schemas/union/unionAsync.d.ts
/**
* Union options async type.
*/
type UnionOptionsAsync = MaybeReadonly<(BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>)[]>;
/**
* Union schema async interface.
*/
interface UnionSchemaAsync<TOptions$1 extends UnionOptionsAsync, TMessage extends ErrorMessage<UnionIssue<InferIssue<TOptions$1[number]>>> | undefined> extends BaseSchemaAsync<InferInput<TOptions$1[number]>, InferOutput<TOptions$1[number]>, UnionIssue<InferIssue<TOptions$1[number]>> | InferIssue<TOptions$1[number]>> {
  /**
  * The schema type.
  */
  readonly type: "union";
  /**
  * The schema reference.
  */
  readonly reference: typeof union | typeof unionAsync;
  /**
  * The union options.
  */
  readonly options: TOptions$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an union schema.
*
* @param options The union options.
*
* @returns An union schema.
*/
declare function unionAsync<const TOptions$1 extends UnionOptionsAsync>(options: TOptions$1): UnionSchemaAsync<TOptions$1, undefined>;
/**
* Creates an union schema.
*
* @param options The union options.
* @param message The error message.
*
* @returns An union schema.
*/
declare function unionAsync<const TOptions$1 extends UnionOptionsAsync, const TMessage extends ErrorMessage<UnionIssue<InferIssue<TOptions$1[number]>>> | undefined>(options: TOptions$1, message: TMessage): UnionSchemaAsync<TOptions$1, TMessage>;
//#endregion
//#region src/schemas/nonNullable/types.d.ts
/**
* Non nullable issue interface.
*/
interface NonNullableIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "non_nullable";
  /**
  * The expected property.
  */
  readonly expected: "!null";
}
/**
* Infer non nullable input type.
*/
type InferNonNullableInput<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = NonNullable$1<InferInput<TWrapped$1>>;
/**
* Infer non nullable output type.
*/
type InferNonNullableOutput<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = NonNullable$1<InferOutput<TWrapped$1>>;
/**
* Infer non nullable issue type.
*/
type InferNonNullableIssue<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = TWrapped$1 extends UnionSchema<UnionOptions, ErrorMessage<UnionIssue<BaseIssue<unknown>>> | undefined> | UnionSchemaAsync<UnionOptionsAsync, ErrorMessage<UnionIssue<BaseIssue<unknown>>> | undefined> ? Exclude<InferIssue<TWrapped$1>, {
  type: "null" | "union";
}> | UnionIssue<InferNonNullableIssue<TWrapped$1["options"][number]>> : Exclude<InferIssue<TWrapped$1>, {
  type: "null";
}>;
//#endregion
//#region src/schemas/nonNullable/nonNullable.d.ts
/**
* Non nullable schema interface.
*/
interface NonNullableSchema<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TMessage extends ErrorMessage<NonNullableIssue> | undefined> extends BaseSchema<InferNonNullableInput<TWrapped$1>, InferNonNullableOutput<TWrapped$1>, NonNullableIssue | InferNonNullableIssue<TWrapped$1>> {
  /**
  * The schema type.
  */
  readonly type: "non_nullable";
  /**
  * The schema reference.
  */
  readonly reference: typeof nonNullable;
  /**
  * The expected property.
  */
  readonly expects: "!null";
  /**
  * The wrapped schema.
  */
  readonly wrapped: TWrapped$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a non nullable schema.
*
* @param wrapped The wrapped schema.
*
* @returns A non nullable schema.
*/
declare function nonNullable<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(wrapped: TWrapped$1): NonNullableSchema<TWrapped$1, undefined>;
/**
* Creates a non nullable schema.
*
* @param wrapped The wrapped schema.
* @param message The error message.
*
* @returns A non nullable schema.
*/
declare function nonNullable<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TMessage extends ErrorMessage<NonNullableIssue> | undefined>(wrapped: TWrapped$1, message: TMessage): NonNullableSchema<TWrapped$1, TMessage>;
//#endregion
//#region src/schemas/nonNullable/nonNullableAsync.d.ts
/**
* Non nullable schema async interface.
*/
interface NonNullableSchemaAsync<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TMessage extends ErrorMessage<NonNullableIssue> | undefined> extends BaseSchemaAsync<InferNonNullableInput<TWrapped$1>, InferNonNullableOutput<TWrapped$1>, NonNullableIssue | InferNonNullableIssue<TWrapped$1>> {
  /**
  * The schema type.
  */
  readonly type: "non_nullable";
  /**
  * The schema reference.
  */
  readonly reference: typeof nonNullable | typeof nonNullableAsync;
  /**
  * The expected property.
  */
  readonly expects: "!null";
  /**
  * The wrapped schema.
  */
  readonly wrapped: TWrapped$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a non nullable schema.
*
* @param wrapped The wrapped schema.
*
* @returns A non nullable schema.
*/
declare function nonNullableAsync<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(wrapped: TWrapped$1): NonNullableSchemaAsync<TWrapped$1, undefined>;
/**
* Creates a non nullable schema.
*
* @param wrapped The wrapped schema.
* @param message The error message.
*
* @returns A non nullable schema.
*/
declare function nonNullableAsync<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TMessage extends ErrorMessage<NonNullableIssue> | undefined>(wrapped: TWrapped$1, message: TMessage): NonNullableSchemaAsync<TWrapped$1, TMessage>;
//#endregion
//#region src/schemas/nonNullish/types.d.ts
/**
* Non nullish issue interface.
*/
interface NonNullishIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "non_nullish";
  /**
  * The expected property.
  */
  readonly expected: "(!null & !undefined)";
}
/**
* Infer non nullish input type.
*/
type InferNonNullishInput<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = NonNullish<InferInput<TWrapped$1>>;
/**
* Infer non nullish output type.
*/
type InferNonNullishOutput<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = NonNullish<InferOutput<TWrapped$1>>;
/**
* Infer non nullish issue type.
*/
type InferNonNullishIssue<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = TWrapped$1 extends UnionSchema<UnionOptions, ErrorMessage<UnionIssue<BaseIssue<unknown>>> | undefined> | UnionSchemaAsync<UnionOptionsAsync, ErrorMessage<UnionIssue<BaseIssue<unknown>>> | undefined> ? Exclude<InferIssue<TWrapped$1>, {
  type: "null" | "undefined" | "union";
}> | UnionIssue<InferNonNullishIssue<TWrapped$1["options"][number]>> : Exclude<InferIssue<TWrapped$1>, {
  type: "null" | "undefined";
}>;
//#endregion
//#region src/schemas/nonNullish/nonNullish.d.ts
/**
* Non nullish schema interface.
*/
interface NonNullishSchema<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TMessage extends ErrorMessage<NonNullishIssue> | undefined> extends BaseSchema<InferNonNullishInput<TWrapped$1>, InferNonNullishOutput<TWrapped$1>, NonNullishIssue | InferNonNullishIssue<TWrapped$1>> {
  /**
  * The schema type.
  */
  readonly type: "non_nullish";
  /**
  * The schema reference.
  */
  readonly reference: typeof nonNullish;
  /**
  * The expected property.
  */
  readonly expects: "(!null & !undefined)";
  /**
  * The wrapped schema.
  */
  readonly wrapped: TWrapped$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a non nullish schema.
*
* @param wrapped The wrapped schema.
*
* @returns A non nullish schema.
*/
declare function nonNullish<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(wrapped: TWrapped$1): NonNullishSchema<TWrapped$1, undefined>;
/**
* Creates a non nullish schema.
*
* @param wrapped The wrapped schema.
* @param message The error message.
*
* @returns A non nullish schema.
*/
declare function nonNullish<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TMessage extends ErrorMessage<NonNullishIssue> | undefined>(wrapped: TWrapped$1, message: TMessage): NonNullishSchema<TWrapped$1, TMessage>;
//#endregion
//#region src/schemas/nonNullish/nonNullishAsync.d.ts
/**
* Non nullish schema async interface.
*/
interface NonNullishSchemaAsync<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TMessage extends ErrorMessage<NonNullishIssue> | undefined> extends BaseSchemaAsync<InferNonNullishInput<TWrapped$1>, InferNonNullishOutput<TWrapped$1>, NonNullishIssue | InferNonNullishIssue<TWrapped$1>> {
  /**
  * The schema type.
  */
  readonly type: "non_nullish";
  /**
  * The schema reference.
  */
  readonly reference: typeof nonNullish | typeof nonNullishAsync;
  /**
  * The expected property.
  */
  readonly expects: "(!null & !undefined)";
  /**
  * The wrapped schema.
  */
  readonly wrapped: TWrapped$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a non nullish schema.
*
* @param wrapped The wrapped schema.
*
* @returns A non nullish schema.
*/
declare function nonNullishAsync<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(wrapped: TWrapped$1): NonNullishSchemaAsync<TWrapped$1, undefined>;
/**
* Creates a non nullish schema.
*
* @param wrapped The wrapped schema.
* @param message The error message.
*
* @returns A non nullish schema.
*/
declare function nonNullishAsync<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TMessage extends ErrorMessage<NonNullishIssue> | undefined>(wrapped: TWrapped$1, message: TMessage): NonNullishSchemaAsync<TWrapped$1, TMessage>;
//#endregion
//#region src/schemas/nonOptional/types.d.ts
/**
* Non optional issue interface.
*/
interface NonOptionalIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "non_optional";
  /**
  * The expected property.
  */
  readonly expected: "!undefined";
}
/**
* Infer non optional input type.
*/
type InferNonOptionalInput<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = NonOptional<InferInput<TWrapped$1>>;
/**
* Infer non optional output type.
*/
type InferNonOptionalOutput<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = NonOptional<InferOutput<TWrapped$1>>;
/**
* Infer non optional issue type.
*/
type InferNonOptionalIssue<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = TWrapped$1 extends UnionSchema<UnionOptions, ErrorMessage<UnionIssue<BaseIssue<unknown>>> | undefined> | UnionSchemaAsync<UnionOptionsAsync, ErrorMessage<UnionIssue<BaseIssue<unknown>>> | undefined> ? Exclude<InferIssue<TWrapped$1>, {
  type: "undefined" | "union";
}> | UnionIssue<InferNonOptionalIssue<TWrapped$1["options"][number]>> : Exclude<InferIssue<TWrapped$1>, {
  type: "undefined";
}>;
//#endregion
//#region src/schemas/nonOptional/nonOptional.d.ts
/**
* Non optional schema interface.
*/
interface NonOptionalSchema<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TMessage extends ErrorMessage<NonOptionalIssue> | undefined> extends BaseSchema<InferNonOptionalInput<TWrapped$1>, InferNonOptionalOutput<TWrapped$1>, NonOptionalIssue | InferNonOptionalIssue<TWrapped$1>> {
  /**
  * The schema type.
  */
  readonly type: "non_optional";
  /**
  * The schema reference.
  */
  readonly reference: typeof nonOptional;
  /**
  * The expected property.
  */
  readonly expects: "!undefined";
  /**
  * The wrapped schema.
  */
  readonly wrapped: TWrapped$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a non optional schema.
*
* @param wrapped The wrapped schema.
*
* @returns A non optional schema.
*/
declare function nonOptional<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(wrapped: TWrapped$1): NonOptionalSchema<TWrapped$1, undefined>;
/**
* Creates a non optional schema.
*
* @param wrapped The wrapped schema.
* @param message The error message.
*
* @returns A non optional schema.
*/
declare function nonOptional<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TMessage extends ErrorMessage<NonOptionalIssue> | undefined>(wrapped: TWrapped$1, message: TMessage): NonOptionalSchema<TWrapped$1, TMessage>;
//#endregion
//#region src/schemas/nonOptional/nonOptionalAsync.d.ts
/**
* Non optional schema async interface.
*/
interface NonOptionalSchemaAsync<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TMessage extends ErrorMessage<NonOptionalIssue> | undefined> extends BaseSchemaAsync<InferNonOptionalInput<TWrapped$1>, InferNonOptionalOutput<TWrapped$1>, NonOptionalIssue | InferNonOptionalIssue<TWrapped$1>> {
  /**
  * The schema type.
  */
  readonly type: "non_optional";
  /**
  * The schema reference.
  */
  readonly reference: typeof nonOptional | typeof nonOptionalAsync;
  /**
  * The expected property.
  */
  readonly expects: "!undefined";
  /**
  * The wrapped schema.
  */
  readonly wrapped: TWrapped$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a non optional schema.
*
* @param wrapped The wrapped schema.
*
* @returns A non optional schema.
*/
declare function nonOptionalAsync<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(wrapped: TWrapped$1): NonOptionalSchemaAsync<TWrapped$1, undefined>;
/**
* Creates a non optional schema.
*
* @param wrapped The wrapped schema.
* @param message The error message.
*
* @returns A non optional schema.
*/
declare function nonOptionalAsync<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TMessage extends ErrorMessage<NonOptionalIssue> | undefined>(wrapped: TWrapped$1, message: TMessage): NonOptionalSchemaAsync<TWrapped$1, TMessage>;
//#endregion
//#region src/schemas/null/null.d.ts
/**
* Null issue interface.
*/
interface NullIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "null";
  /**
  * The expected property.
  */
  readonly expected: "null";
}
/**
* Null schema interface.
*/
interface NullSchema<TMessage extends ErrorMessage<NullIssue> | undefined> extends BaseSchema<null, null, NullIssue> {
  /**
  * The schema type.
  */
  readonly type: "null";
  /**
  * The schema reference.
  */
  readonly reference: typeof null_;
  /**
  * The expected property.
  */
  readonly expects: "null";
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a null schema.
*
* @returns A null schema.
*/
declare function null_(): NullSchema<undefined>;
/**
* Creates a null schema.
*
* @param message The error message.
*
* @returns A null schema.
*/
declare function null_<const TMessage extends ErrorMessage<NullIssue> | undefined>(message: TMessage): NullSchema<TMessage>;
//#endregion
//#region src/schemas/nullable/types.d.ts
/**
* Infer nullable output type.
*/
type InferNullableOutput<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TDefault extends DefaultAsync<TWrapped$1, null>> = undefined extends TDefault ? InferOutput<TWrapped$1> | null : InferOutput<TWrapped$1> | Extract<DefaultValue<TDefault>, null>;
//#endregion
//#region src/schemas/nullable/nullable.d.ts
/**
* Nullable schema interface.
*/
interface NullableSchema<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TDefault extends Default<TWrapped$1, null>> extends BaseSchema<InferInput<TWrapped$1> | null, InferNullableOutput<TWrapped$1, TDefault>, InferIssue<TWrapped$1>> {
  /**
  * The schema type.
  */
  readonly type: "nullable";
  /**
  * The schema reference.
  */
  readonly reference: typeof nullable;
  /**
  * The expected property.
  */
  readonly expects: `(${TWrapped$1["expects"]} | null)`;
  /**
  * The wrapped schema.
  */
  readonly wrapped: TWrapped$1;
  /**
  * The default value.
  */
  readonly default: TDefault;
}
/**
* Creates a nullable schema.
*
* @param wrapped The wrapped schema.
*
* @returns A nullable schema.
*/
declare function nullable<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(wrapped: TWrapped$1): NullableSchema<TWrapped$1, undefined>;
/**
* Creates a nullable schema.
*
* @param wrapped The wrapped schema.
* @param default_ The default value.
*
* @returns A nullable schema.
*/
declare function nullable<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TDefault extends Default<TWrapped$1, null>>(wrapped: TWrapped$1, default_: TDefault): NullableSchema<TWrapped$1, TDefault>;
//#endregion
//#region src/schemas/nullable/nullableAsync.d.ts
/**
* Nullable schema async interface.
*/
interface NullableSchemaAsync<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TDefault extends DefaultAsync<TWrapped$1, null>> extends BaseSchemaAsync<InferInput<TWrapped$1> | null, InferNullableOutput<TWrapped$1, TDefault>, InferIssue<TWrapped$1>> {
  /**
  * The schema type.
  */
  readonly type: "nullable";
  /**
  * The schema reference.
  */
  readonly reference: typeof nullable | typeof nullableAsync;
  /**
  * The expected property.
  */
  readonly expects: `(${TWrapped$1["expects"]} | null)`;
  /**
  * The wrapped schema.
  */
  readonly wrapped: TWrapped$1;
  /**
  * The default value.
  */
  readonly default: TDefault;
}
/**
* Creates a nullable schema.
*
* @param wrapped The wrapped schema.
*
* @returns A nullable schema.
*/
declare function nullableAsync<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(wrapped: TWrapped$1): NullableSchemaAsync<TWrapped$1, undefined>;
/**
* Creates a nullable schema.
*
* @param wrapped The wrapped schema.
* @param default_ The default value.
*
* @returns A nullable schema.
*/
declare function nullableAsync<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TDefault extends DefaultAsync<TWrapped$1, null>>(wrapped: TWrapped$1, default_: TDefault): NullableSchemaAsync<TWrapped$1, TDefault>;
//#endregion
//#region src/schemas/nullish/types.d.ts
/**
* Infer nullish output type.
*/
type InferNullishOutput<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TDefault extends DefaultAsync<TWrapped$1, null | undefined>> = undefined extends TDefault ? InferOutput<TWrapped$1> | null | undefined : InferOutput<TWrapped$1> | Extract<DefaultValue<TDefault>, null | undefined>;
//#endregion
//#region src/schemas/nullish/nullish.d.ts
/**
* Nullish schema interface.
*/
interface NullishSchema<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TDefault extends Default<TWrapped$1, null | undefined>> extends BaseSchema<InferInput<TWrapped$1> | null | undefined, InferNullishOutput<TWrapped$1, TDefault>, InferIssue<TWrapped$1>> {
  /**
  * The schema type.
  */
  readonly type: "nullish";
  /**
  * The schema reference.
  */
  readonly reference: typeof nullish;
  /**
  * The expected property.
  */
  readonly expects: `(${TWrapped$1["expects"]} | null | undefined)`;
  /**
  * The wrapped schema.
  */
  readonly wrapped: TWrapped$1;
  /**
  * The default value.
  */
  readonly default: TDefault;
}
/**
* Creates a nullish schema.
*
* @param wrapped The wrapped schema.
*
* @returns A nullish schema.
*/
declare function nullish<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(wrapped: TWrapped$1): NullishSchema<TWrapped$1, undefined>;
/**
* Creates a nullish schema.
*
* @param wrapped The wrapped schema.
* @param default_ The default value.
*
* @returns A nullish schema.
*/
declare function nullish<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TDefault extends Default<TWrapped$1, null | undefined>>(wrapped: TWrapped$1, default_: TDefault): NullishSchema<TWrapped$1, TDefault>;
//#endregion
//#region src/schemas/nullish/nullishAsync.d.ts
/**
* Nullish schema async interface.
*/
interface NullishSchemaAsync<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TDefault extends DefaultAsync<TWrapped$1, null | undefined>> extends BaseSchemaAsync<InferInput<TWrapped$1> | null | undefined, InferNullishOutput<TWrapped$1, TDefault>, InferIssue<TWrapped$1>> {
  /**
  * The schema type.
  */
  readonly type: "nullish";
  /**
  * The schema reference.
  */
  readonly reference: typeof nullish | typeof nullishAsync;
  /**
  * The expected property.
  */
  readonly expects: `(${TWrapped$1["expects"]} | null | undefined)`;
  /**
  * The wrapped schema.
  */
  readonly wrapped: TWrapped$1;
  /**
  * The default value.
  */
  readonly default: TDefault;
}
/**
* Creates a nullish schema.
*
* @param wrapped The wrapped schema.
*
* @returns A nullish schema.
*/
declare function nullishAsync<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(wrapped: TWrapped$1): NullishSchemaAsync<TWrapped$1, undefined>;
/**
* Creates a nullish schema.
*
* @param wrapped The wrapped schema.
* @param default_ The default value.
*
* @returns A nullish schema.
*/
declare function nullishAsync<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TDefault extends DefaultAsync<TWrapped$1, null | undefined>>(wrapped: TWrapped$1, default_: TDefault): NullishSchemaAsync<TWrapped$1, TDefault>;
//#endregion
//#region src/schemas/number/number.d.ts
/**
* Number issue interface.
*/
interface NumberIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "number";
  /**
  * The expected property.
  */
  readonly expected: "number";
}
/**
* Number schema interface.
*/
interface NumberSchema<TMessage extends ErrorMessage<NumberIssue> | undefined> extends BaseSchema<number, number, NumberIssue> {
  /**
  * The schema type.
  */
  readonly type: "number";
  /**
  * The schema reference.
  */
  readonly reference: typeof number;
  /**
  * The expected property.
  */
  readonly expects: "number";
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a number schema.
*
* @returns A number schema.
*/
declare function number(): NumberSchema<undefined>;
/**
* Creates a number schema.
*
* @param message The error message.
*
* @returns A number schema.
*/
declare function number<const TMessage extends ErrorMessage<NumberIssue> | undefined>(message: TMessage): NumberSchema<TMessage>;
//#endregion
//#region src/schemas/object/types.d.ts
/**
* Object issue interface.
*/
interface ObjectIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "object";
  /**
  * The expected property.
  */
  readonly expected: "Object" | `"${string}"`;
}
//#endregion
//#region src/schemas/object/object.d.ts
/**
* Object schema interface.
*/
interface ObjectSchema<TEntries$1 extends ObjectEntries, TMessage extends ErrorMessage<ObjectIssue> | undefined> extends BaseSchema<InferObjectInput<TEntries$1>, InferObjectOutput<TEntries$1>, ObjectIssue | InferObjectIssue<TEntries$1>> {
  /**
  * The schema type.
  */
  readonly type: "object";
  /**
  * The schema reference.
  */
  readonly reference: typeof object;
  /**
  * The expected property.
  */
  readonly expects: "Object";
  /**
  * The entries schema.
  */
  readonly entries: TEntries$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an object schema.
*
* Hint: This schema removes unknown entries. The output will only include the
* entries you specify. To include unknown entries, use `looseObject`. To
* return an issue for unknown entries, use `strictObject`. To include and
* validate unknown entries, use `objectWithRest`.
*
* @param entries The entries schema.
*
* @returns An object schema.
*/
declare function object<const TEntries$1 extends ObjectEntries>(entries: TEntries$1): ObjectSchema<TEntries$1, undefined>;
/**
* Creates an object schema.
*
* Hint: This schema removes unknown entries. The output will only include the
* entries you specify. To include unknown entries, use `looseObject`. To
* return an issue for unknown entries, use `strictObject`. To include and
* validate unknown entries, use `objectWithRest`.
*
* @param entries The entries schema.
* @param message The error message.
*
* @returns An object schema.
*/
declare function object<const TEntries$1 extends ObjectEntries, const TMessage extends ErrorMessage<ObjectIssue> | undefined>(entries: TEntries$1, message: TMessage): ObjectSchema<TEntries$1, TMessage>;
//#endregion
//#region src/schemas/object/objectAsync.d.ts
/**
* Object schema async interface.
*/
interface ObjectSchemaAsync<TEntries$1 extends ObjectEntriesAsync, TMessage extends ErrorMessage<ObjectIssue> | undefined> extends BaseSchemaAsync<InferObjectInput<TEntries$1>, InferObjectOutput<TEntries$1>, ObjectIssue | InferObjectIssue<TEntries$1>> {
  /**
  * The schema type.
  */
  readonly type: "object";
  /**
  * The schema reference.
  */
  readonly reference: typeof object | typeof objectAsync;
  /**
  * The expected property.
  */
  readonly expects: "Object";
  /**
  * The entries schema.
  */
  readonly entries: TEntries$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an object schema.
*
* Hint: This schema removes unknown entries. The output will only include the
* entries you specify. To include unknown entries, use `looseObjectAsync`. To
* return an issue for unknown entries, use `strictObjectAsync`. To include and
* validate unknown entries, use `objectWithRestAsync`.
*
* @param entries The entries schema.
*
* @returns An object schema.
*/
declare function objectAsync<const TEntries$1 extends ObjectEntriesAsync>(entries: TEntries$1): ObjectSchemaAsync<TEntries$1, undefined>;
/**
* Creates an object schema.
*
* Hint: This schema removes unknown entries. The output will only include the
* entries you specify. To include unknown entries, use `looseObjectAsync`. To
* return an issue for unknown entries, use `strictObjectAsync`. To include and
* validate unknown entries, use `objectWithRestAsync`.
*
* @param entries The entries schema.
* @param message The error message.
*
* @returns An object schema.
*/
declare function objectAsync<const TEntries$1 extends ObjectEntriesAsync, const TMessage extends ErrorMessage<ObjectIssue> | undefined>(entries: TEntries$1, message: TMessage): ObjectSchemaAsync<TEntries$1, TMessage>;
//#endregion
//#region src/schemas/objectWithRest/types.d.ts
/**
* Object with rest issue interface.
*/
interface ObjectWithRestIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "object_with_rest";
  /**
  * The expected property.
  */
  readonly expected: "Object" | `"${string}"`;
}
//#endregion
//#region src/schemas/objectWithRest/objectWithRest.d.ts
/**
* Object with rest schema interface.
*/
interface ObjectWithRestSchema<TEntries$1 extends ObjectEntries, TRest$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TMessage extends ErrorMessage<ObjectWithRestIssue> | undefined> extends BaseSchema<InferObjectInput<TEntries$1> & {
  [key: string]: InferInput<TRest$1>;
}, InferObjectOutput<TEntries$1> & {
  [key: string]: InferOutput<TRest$1>;
}, ObjectWithRestIssue | InferObjectIssue<TEntries$1> | InferIssue<TRest$1>> {
  /**
  * The schema type.
  */
  readonly type: "object_with_rest";
  /**
  * The schema reference.
  */
  readonly reference: typeof objectWithRest;
  /**
  * The expected property.
  */
  readonly expects: "Object";
  /**
  * The entries schema.
  */
  readonly entries: TEntries$1;
  /**
  * The rest schema.
  */
  readonly rest: TRest$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an object with rest schema.
*
* @param entries The entries schema.
* @param rest The rest schema.
*
* @returns An object with rest schema.
*/
declare function objectWithRest<const TEntries$1 extends ObjectEntries, const TRest$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(entries: TEntries$1, rest: TRest$1): ObjectWithRestSchema<TEntries$1, TRest$1, undefined>;
/**
* Creates an object with rest schema.
*
* @param entries The entries schema.
* @param rest The rest schema.
* @param message The error message.
*
* @returns An object with rest schema.
*/
declare function objectWithRest<const TEntries$1 extends ObjectEntries, const TRest$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TMessage extends ErrorMessage<ObjectWithRestIssue> | undefined>(entries: TEntries$1, rest: TRest$1, message: TMessage): ObjectWithRestSchema<TEntries$1, TRest$1, TMessage>;
//#endregion
//#region src/schemas/objectWithRest/objectWithRestAsync.d.ts
/**
* Object schema async interface.
*/
interface ObjectWithRestSchemaAsync<TEntries$1 extends ObjectEntriesAsync, TRest$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TMessage extends ErrorMessage<ObjectWithRestIssue> | undefined> extends BaseSchemaAsync<InferObjectInput<TEntries$1> & {
  [key: string]: InferInput<TRest$1>;
}, InferObjectOutput<TEntries$1> & {
  [key: string]: InferOutput<TRest$1>;
}, ObjectWithRestIssue | InferObjectIssue<TEntries$1> | InferIssue<TRest$1>> {
  /**
  * The schema type.
  */
  readonly type: "object_with_rest";
  /**
  * The schema reference.
  */
  readonly reference: typeof objectWithRest | typeof objectWithRestAsync;
  /**
  * The expected property.
  */
  readonly expects: "Object";
  /**
  * The entries schema.
  */
  readonly entries: TEntries$1;
  /**
  * The rest schema.
  */
  readonly rest: TRest$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an object with rest schema.
*
* @param entries The entries schema.
* @param rest The rest schema.
*
* @returns An object with rest schema.
*/
declare function objectWithRestAsync<const TEntries$1 extends ObjectEntriesAsync, const TRest$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(entries: TEntries$1, rest: TRest$1): ObjectWithRestSchemaAsync<TEntries$1, TRest$1, undefined>;
/**
* Creates an object with rest schema.
*
* @param entries The entries schema.
* @param rest The rest schema.
* @param message The error message.
*
* @returns An object with rest schema.
*/
declare function objectWithRestAsync<const TEntries$1 extends ObjectEntriesAsync, const TRest$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TMessage extends ErrorMessage<ObjectWithRestIssue> | undefined>(entries: TEntries$1, rest: TRest$1, message: TMessage): ObjectWithRestSchemaAsync<TEntries$1, TRest$1, TMessage>;
//#endregion
//#region src/schemas/optional/types.d.ts
/**
* Infer optional output type.
*/
type InferOptionalOutput<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TDefault extends DefaultAsync<TWrapped$1, undefined>> = undefined extends TDefault ? InferOutput<TWrapped$1> | undefined : InferOutput<TWrapped$1> | Extract<DefaultValue<TDefault>, undefined>;
//#endregion
//#region src/schemas/optional/optional.d.ts
/**
* Optional schema interface.
*/
interface OptionalSchema<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TDefault extends Default<TWrapped$1, undefined>> extends BaseSchema<InferInput<TWrapped$1> | undefined, InferOptionalOutput<TWrapped$1, TDefault>, InferIssue<TWrapped$1>> {
  /**
  * The schema type.
  */
  readonly type: "optional";
  /**
  * The schema reference.
  */
  readonly reference: typeof optional;
  /**
  * The expected property.
  */
  readonly expects: `(${TWrapped$1["expects"]} | undefined)`;
  /**
  * The wrapped schema.
  */
  readonly wrapped: TWrapped$1;
  /**
  * The default value.
  */
  readonly default: TDefault;
}
/**
* Creates an optional schema.
*
* @param wrapped The wrapped schema.
*
* @returns An optional schema.
*/
declare function optional<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(wrapped: TWrapped$1): OptionalSchema<TWrapped$1, undefined>;
/**
* Creates an optional schema.
*
* @param wrapped The wrapped schema.
* @param default_ The default value.
*
* @returns An optional schema.
*/
declare function optional<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TDefault extends Default<TWrapped$1, undefined>>(wrapped: TWrapped$1, default_: TDefault): OptionalSchema<TWrapped$1, TDefault>;
//#endregion
//#region src/schemas/optional/optionalAsync.d.ts
/**
* Optional schema async interface.
*/
interface OptionalSchemaAsync<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TDefault extends DefaultAsync<TWrapped$1, undefined>> extends BaseSchemaAsync<InferInput<TWrapped$1> | undefined, InferOptionalOutput<TWrapped$1, TDefault>, InferIssue<TWrapped$1>> {
  /**
  * The schema type.
  */
  readonly type: "optional";
  /**
  * The schema reference.
  */
  readonly reference: typeof optional | typeof optionalAsync;
  /**
  * The expected property.
  */
  readonly expects: `(${TWrapped$1["expects"]} | undefined)`;
  /**
  * The wrapped schema.
  */
  readonly wrapped: TWrapped$1;
  /**
  * The default value.
  */
  readonly default: TDefault;
}
/**
* Creates an optional schema.
*
* @param wrapped The wrapped schema.
*
* @returns An optional schema.
*/
declare function optionalAsync<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(wrapped: TWrapped$1): OptionalSchemaAsync<TWrapped$1, undefined>;
/**
* Creates an optional schema.
*
* @param wrapped The wrapped schema.
* @param default_ The default value.
*
* @returns An optional schema.
*/
declare function optionalAsync<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TDefault extends DefaultAsync<TWrapped$1, undefined>>(wrapped: TWrapped$1, default_: TDefault): OptionalSchemaAsync<TWrapped$1, TDefault>;
//#endregion
//#region src/schemas/picklist/picklist.d.ts
/**
* Picklist options type.
*/
type PicklistOptions = MaybeReadonly<(string | number | bigint)[]>;
/**
* Picklist issue interface.
*/
interface PicklistIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "picklist";
  /**
  * The expected property.
  */
  readonly expected: string;
}
/**
* Picklist schema interface.
*/
interface PicklistSchema<TOptions$1 extends PicklistOptions, TMessage extends ErrorMessage<PicklistIssue> | undefined> extends BaseSchema<TOptions$1[number], TOptions$1[number], PicklistIssue> {
  /**
  * The schema type.
  */
  readonly type: "picklist";
  /**
  * The schema reference.
  */
  readonly reference: typeof picklist;
  /**
  * The picklist options.
  */
  readonly options: TOptions$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a picklist schema.
*
* @param options The picklist options.
*
* @returns A picklist schema.
*/
declare function picklist<const TOptions$1 extends PicklistOptions>(options: TOptions$1): PicklistSchema<TOptions$1, undefined>;
/**
* Creates a picklist schema.
*
* @param options The picklist options.
* @param message The error message.
*
* @returns A picklist schema.
*/
declare function picklist<const TOptions$1 extends PicklistOptions, const TMessage extends ErrorMessage<PicklistIssue> | undefined>(options: TOptions$1, message: TMessage): PicklistSchema<TOptions$1, TMessage>;
//#endregion
//#region src/schemas/promise/promise.d.ts
/**
* Promise issue interface.
*/
interface PromiseIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "promise";
  /**
  * The expected property.
  */
  readonly expected: "Promise";
}
/**
* Promise schema interface.
*/
interface PromiseSchema<TMessage extends ErrorMessage<PromiseIssue> | undefined> extends BaseSchema<Promise<unknown>, Promise<unknown>, PromiseIssue> {
  /**
  * The schema type.
  */
  readonly type: "promise";
  /**
  * The schema reference.
  */
  readonly reference: typeof promise;
  /**
  * The expected property.
  */
  readonly expects: "Promise";
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a promise schema.
*
* @returns A promise schema.
*/
declare function promise(): PromiseSchema<undefined>;
/**
* Creates a promise schema.
*
* @param message The error message.
*
* @returns A promise schema.
*/
declare function promise<const TMessage extends ErrorMessage<PromiseIssue> | undefined>(message: TMessage): PromiseSchema<TMessage>;
//#endregion
//#region src/schemas/record/types.d.ts
/**
* Record issue interface.
*/
interface RecordIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "record";
  /**
  * The expected property.
  */
  readonly expected: "Object";
}
/**
* Is literal type.
*/
type IsLiteral<TKey$1 extends string | number | symbol> = string extends TKey$1 ? false : number extends TKey$1 ? false : symbol extends TKey$1 ? false : TKey$1 extends Brand<string | number | symbol> ? false : true;
/**
* Optional keys type.
*/
type OptionalKeys<TObject extends Record<string | number | symbol, unknown>> = { [TKey in keyof TObject]: IsLiteral<TKey> extends true ? TKey : never }[keyof TObject];
/**
* With question marks type.
*
* Hint: We mark an entry as optional if we detect that its key is a literal
* type. The reason for this is that it is not technically possible to detect
* missing literal keys without restricting the key schema to `string`, `enum`
* and `picklist`. However, if `enum` and `picklist` are used, it is better to
* use `object` with `entriesFromList` because it already covers the needed
* functionality. This decision also reduces the bundle size of `record`,
* because it only needs to check the entries of the input and not any missing
* keys.
*/
type WithQuestionMarks<TObject extends Record<string | number | symbol, unknown>> = MarkOptional<TObject, OptionalKeys<TObject>>;
/**
* With readonly type.
*/
type WithReadonly<TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TObject extends WithQuestionMarks<Record<string | number | symbol, unknown>>> = TValue$1 extends {
  readonly pipe: readonly unknown[];
} ? ReadonlyAction<any> extends TValue$1["pipe"][number] ? Readonly<TObject> : TObject : TObject;
/**
* Infer record input type.
*/
type InferRecordInput<TKey$1 extends BaseSchema<string, string | number | symbol, BaseIssue<unknown>> | BaseSchemaAsync<string, string | number | symbol, BaseIssue<unknown>>, TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = Prettify<WithQuestionMarks<Record<InferInput<TKey$1>, InferInput<TValue$1>>>>;
/**
* Infer record output type.
*/
type InferRecordOutput<TKey$1 extends BaseSchema<string, string | number | symbol, BaseIssue<unknown>> | BaseSchemaAsync<string, string | number | symbol, BaseIssue<unknown>>, TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = Prettify<WithReadonly<TValue$1, WithQuestionMarks<Record<InferOutput<TKey$1>, InferOutput<TValue$1>>>>>;
//#endregion
//#region src/schemas/record/record.d.ts
/**
* Record schema interface.
*/
interface RecordSchema<TKey$1 extends BaseSchema<string, string | number | symbol, BaseIssue<unknown>>, TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TMessage extends ErrorMessage<RecordIssue> | undefined> extends BaseSchema<InferRecordInput<TKey$1, TValue$1>, InferRecordOutput<TKey$1, TValue$1>, RecordIssue | InferIssue<TKey$1> | InferIssue<TValue$1>> {
  /**
  * The schema type.
  */
  readonly type: "record";
  /**
  * The schema reference.
  */
  readonly reference: typeof record;
  /**
  * The expected property.
  */
  readonly expects: "Object";
  /**
  * The record key schema.
  */
  readonly key: TKey$1;
  /**
  * The record value schema.
  */
  readonly value: TValue$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a record schema.
*
* @param key The key schema.
* @param value The value schema.
*
* @returns A record schema.
*/
declare function record<const TKey$1 extends BaseSchema<string, string | number | symbol, BaseIssue<unknown>>, const TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(key: TKey$1, value: TValue$1): RecordSchema<TKey$1, TValue$1, undefined>;
/**
* Creates a record schema.
*
* @param key The key schema.
* @param value The value schema.
* @param message The error message.
*
* @returns A record schema.
*/
declare function record<const TKey$1 extends BaseSchema<string, string | number | symbol, BaseIssue<unknown>>, const TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TMessage extends ErrorMessage<RecordIssue> | undefined>(key: TKey$1, value: TValue$1, message: TMessage): RecordSchema<TKey$1, TValue$1, TMessage>;
//#endregion
//#region src/schemas/record/recordAsync.d.ts
/**
* Record schema async interface.
*/
interface RecordSchemaAsync<TKey$1 extends BaseSchema<string, string | number | symbol, BaseIssue<unknown>> | BaseSchemaAsync<string, string | number | symbol, BaseIssue<unknown>>, TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TMessage extends ErrorMessage<RecordIssue> | undefined> extends BaseSchemaAsync<InferRecordInput<TKey$1, TValue$1>, InferRecordOutput<TKey$1, TValue$1>, RecordIssue | InferIssue<TKey$1> | InferIssue<TValue$1>> {
  /**
  * The schema type.
  */
  readonly type: "record";
  /**
  * The schema reference.
  */
  readonly reference: typeof record | typeof recordAsync;
  /**
  * The expected property.
  */
  readonly expects: "Object";
  /**
  * The record key schema.
  */
  readonly key: TKey$1;
  /**
  * The record value schema.
  */
  readonly value: TValue$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a record schema.
*
* @param key The key schema.
* @param value The value schema.
*
* @returns A record schema.
*/
declare function recordAsync<const TKey$1 extends BaseSchema<string, string | number | symbol, BaseIssue<unknown>> | BaseSchemaAsync<string, string | number | symbol, BaseIssue<unknown>>, const TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(key: TKey$1, value: TValue$1): RecordSchemaAsync<TKey$1, TValue$1, undefined>;
/**
* Creates a record schema.
*
* @param key The key schema.
* @param value The value schema.
* @param message The error message.
*
* @returns A record schema.
*/
declare function recordAsync<const TKey$1 extends BaseSchema<string, string | number | symbol, BaseIssue<unknown>> | BaseSchemaAsync<string, string | number | symbol, BaseIssue<unknown>>, const TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TMessage extends ErrorMessage<RecordIssue> | undefined>(key: TKey$1, value: TValue$1, message: TMessage): RecordSchemaAsync<TKey$1, TValue$1, TMessage>;
//#endregion
//#region src/schemas/set/types.d.ts
/**
* Set issue interface.
*/
interface SetIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "set";
  /**
  * The expected property.
  */
  readonly expected: "Set";
}
/**
* Infer set input type.
*/
type InferSetInput<TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = Set<InferInput<TValue$1>>;
/**
* Infer set output type.
*/
type InferSetOutput<TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>> = Set<InferOutput<TValue$1>>;
//#endregion
//#region src/schemas/set/set.d.ts
/**
* Set schema interface.
*/
interface SetSchema<TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TMessage extends ErrorMessage<SetIssue> | undefined> extends BaseSchema<InferSetInput<TValue$1>, InferSetOutput<TValue$1>, SetIssue | InferIssue<TValue$1>> {
  /**
  * The schema type.
  */
  readonly type: "set";
  /**
  * The schema reference.
  */
  readonly reference: typeof set;
  /**
  * The expected property.
  */
  readonly expects: "Set";
  /**
  * The set value schema.
  */
  readonly value: TValue$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a set schema.
*
* @param value The value schema.
*
* @returns A set schema.
*/
declare function set<const TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(value: TValue$1): SetSchema<TValue$1, undefined>;
/**
* Creates a set schema.
*
* @param value The value schema.
* @param message The error message.
*
* @returns A set schema.
*/
declare function set<const TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TMessage extends ErrorMessage<SetIssue> | undefined>(value: TValue$1, message: TMessage): SetSchema<TValue$1, TMessage>;
//#endregion
//#region src/schemas/set/setAsync.d.ts
/**
* Set schema async interface.
*/
interface SetSchemaAsync<TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TMessage extends ErrorMessage<SetIssue> | undefined> extends BaseSchemaAsync<InferSetInput<TValue$1>, InferSetOutput<TValue$1>, SetIssue | InferIssue<TValue$1>> {
  /**
  * The schema type.
  */
  readonly type: "set";
  /**
  * The schema reference.
  */
  readonly reference: typeof set | typeof setAsync;
  /**
  * The expected property.
  */
  readonly expects: "Set";
  /**
  * The set value schema.
  */
  readonly value: TValue$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a set schema.
*
* @param value The value schema.
*
* @returns A set schema.
*/
declare function setAsync<const TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(value: TValue$1): SetSchemaAsync<TValue$1, undefined>;
/**
* Creates a set schema.
*
* @param value The value schema.
* @param message The error message.
*
* @returns A set schema.
*/
declare function setAsync<const TValue$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TMessage extends ErrorMessage<SetIssue> | undefined>(value: TValue$1, message: TMessage): SetSchemaAsync<TValue$1, TMessage>;
//#endregion
//#region src/schemas/strictObject/types.d.ts
/**
* Strict object issue interface.
*/
interface StrictObjectIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "strict_object";
  /**
  * The expected property.
  */
  readonly expected: "Object" | `"${string}"` | "never";
}
//#endregion
//#region src/schemas/strictObject/strictObject.d.ts
/**
* Strict object schema interface.
*/
interface StrictObjectSchema<TEntries$1 extends ObjectEntries, TMessage extends ErrorMessage<StrictObjectIssue> | undefined> extends BaseSchema<InferObjectInput<TEntries$1>, InferObjectOutput<TEntries$1>, StrictObjectIssue | InferObjectIssue<TEntries$1>> {
  /**
  * The schema type.
  */
  readonly type: "strict_object";
  /**
  * The schema reference.
  */
  readonly reference: typeof strictObject;
  /**
  * The expected property.
  */
  readonly expects: "Object";
  /**
  * The entries schema.
  */
  readonly entries: TEntries$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a strict object schema.
*
* @param entries The entries schema.
*
* @returns A strict object schema.
*/
declare function strictObject<const TEntries$1 extends ObjectEntries>(entries: TEntries$1): StrictObjectSchema<TEntries$1, undefined>;
/**
* Creates a strict object schema.
*
* @param entries The entries schema.
* @param message The error message.
*
* @returns A strict object schema.
*/
declare function strictObject<const TEntries$1 extends ObjectEntries, const TMessage extends ErrorMessage<StrictObjectIssue> | undefined>(entries: TEntries$1, message: TMessage): StrictObjectSchema<TEntries$1, TMessage>;
//#endregion
//#region src/schemas/strictObject/strictObjectAsync.d.ts
/**
* Strict object schema async interface.
*/
interface StrictObjectSchemaAsync<TEntries$1 extends ObjectEntriesAsync, TMessage extends ErrorMessage<StrictObjectIssue> | undefined> extends BaseSchemaAsync<InferObjectInput<TEntries$1>, InferObjectOutput<TEntries$1>, StrictObjectIssue | InferObjectIssue<TEntries$1>> {
  /**
  * The schema type.
  */
  readonly type: "strict_object";
  /**
  * The schema reference.
  */
  readonly reference: typeof strictObject | typeof strictObjectAsync;
  /**
  * The expected property.
  */
  readonly expects: "Object";
  /**
  * The entries schema.
  */
  readonly entries: TEntries$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a strict object schema.
*
* @param entries The entries schema.
*
* @returns A strict object schema.
*/
declare function strictObjectAsync<const TEntries$1 extends ObjectEntriesAsync>(entries: TEntries$1): StrictObjectSchemaAsync<TEntries$1, undefined>;
/**
* Creates a strict object schema.
*
* @param entries The entries schema.
* @param message The error message.
*
* @returns A strict object schema.
*/
declare function strictObjectAsync<const TEntries$1 extends ObjectEntriesAsync, const TMessage extends ErrorMessage<StrictObjectIssue> | undefined>(entries: TEntries$1, message: TMessage): StrictObjectSchemaAsync<TEntries$1, TMessage>;
//#endregion
//#region src/schemas/strictTuple/types.d.ts
/**
* Strict tuple issue interface.
*/
interface StrictTupleIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "strict_tuple";
  /**
  * The expected property.
  */
  readonly expected: "Array" | "never";
}
//#endregion
//#region src/schemas/strictTuple/strictTuple.d.ts
/**
* Strict tuple schema interface.
*/
interface StrictTupleSchema<TItems$1 extends TupleItems, TMessage extends ErrorMessage<StrictTupleIssue> | undefined> extends BaseSchema<InferTupleInput<TItems$1>, InferTupleOutput<TItems$1>, StrictTupleIssue | InferTupleIssue<TItems$1>> {
  /**
  * The schema type.
  */
  readonly type: "strict_tuple";
  /**
  * The schema reference.
  */
  readonly reference: typeof strictTuple;
  /**
  * The expected property.
  */
  readonly expects: "Array";
  /**
  * The items schema.
  */
  readonly items: TItems$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a strict tuple schema.
*
* @param items The items schema.
*
* @returns A strict tuple schema.
*/
declare function strictTuple<const TItems$1 extends TupleItems>(items: TItems$1): StrictTupleSchema<TItems$1, undefined>;
/**
* Creates a strict tuple schema.
*
* @param items The items schema.
* @param message The error message.
*
* @returns A strict tuple schema.
*/
declare function strictTuple<const TItems$1 extends TupleItems, const TMessage extends ErrorMessage<StrictTupleIssue> | undefined>(items: TItems$1, message: TMessage): StrictTupleSchema<TItems$1, TMessage>;
//#endregion
//#region src/schemas/strictTuple/strictTupleAsync.d.ts
/**
* Strict tuple schema async interface.
*/
interface StrictTupleSchemaAsync<TItems$1 extends TupleItemsAsync, TMessage extends ErrorMessage<StrictTupleIssue> | undefined> extends BaseSchemaAsync<InferTupleInput<TItems$1>, InferTupleOutput<TItems$1>, StrictTupleIssue | InferTupleIssue<TItems$1>> {
  /**
  * The schema type.
  */
  readonly type: "strict_tuple";
  /**
  * The schema reference.
  */
  readonly reference: typeof strictTuple | typeof strictTupleAsync;
  /**
  * The expected property.
  */
  readonly expects: "Array";
  /**
  * The items schema.
  */
  readonly items: TItems$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a strict tuple schema.
*
* @param items The items schema.
*
* @returns A strict tuple schema.
*/
declare function strictTupleAsync<const TItems$1 extends TupleItemsAsync>(items: TItems$1): StrictTupleSchemaAsync<TItems$1, undefined>;
/**
* Creates a strict tuple schema.
*
* @param items The items schema.
* @param message The error message.
*
* @returns A strict tuple schema.
*/
declare function strictTupleAsync<const TItems$1 extends TupleItemsAsync, const TMessage extends ErrorMessage<StrictTupleIssue> | undefined>(items: TItems$1, message: TMessage): StrictTupleSchemaAsync<TItems$1, TMessage>;
//#endregion
//#region src/schemas/string/string.d.ts
/**
* String issue interface.
*/
interface StringIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "string";
  /**
  * The expected property.
  */
  readonly expected: "string";
}
/**
* String schema interface.
*/
interface StringSchema<TMessage extends ErrorMessage<StringIssue> | undefined> extends BaseSchema<string, string, StringIssue> {
  /**
  * The schema type.
  */
  readonly type: "string";
  /**
  * The schema reference.
  */
  readonly reference: typeof string;
  /**
  * The expected property.
  */
  readonly expects: "string";
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a string schema.
*
* @returns A string schema.
*/
declare function string(): StringSchema<undefined>;
/**
* Creates a string schema.
*
* @param message The error message.
*
* @returns A string schema.
*/
declare function string<const TMessage extends ErrorMessage<StringIssue> | undefined>(message: TMessage): StringSchema<TMessage>;
//#endregion
//#region src/schemas/symbol/symbol.d.ts
/**
* Symbol issue interface.
*/
interface SymbolIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "symbol";
  /**
  * The expected property.
  */
  readonly expected: "symbol";
}
/**
* Symbol schema interface.
*/
interface SymbolSchema<TMessage extends ErrorMessage<SymbolIssue> | undefined> extends BaseSchema<symbol, symbol, SymbolIssue> {
  /**
  * The schema type.
  */
  readonly type: "symbol";
  /**
  * The schema reference.
  */
  readonly reference: typeof symbol;
  /**
  * The expected property.
  */
  readonly expects: "symbol";
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a symbol schema.
*
* @returns A symbol schema.
*/
declare function symbol(): SymbolSchema<undefined>;
/**
* Creates a symbol schema.
*
* @param message The error message.
*
* @returns A symbol schema.
*/
declare function symbol<const TMessage extends ErrorMessage<SymbolIssue> | undefined>(message: TMessage): SymbolSchema<TMessage>;
//#endregion
//#region src/schemas/tuple/types.d.ts
/**
* Tuple issue interface.
*/
interface TupleIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "tuple";
  /**
  * The expected property.
  */
  readonly expected: "Array";
}
//#endregion
//#region src/schemas/tuple/tuple.d.ts
/**
* Tuple schema interface.
*/
interface TupleSchema<TItems$1 extends TupleItems, TMessage extends ErrorMessage<TupleIssue> | undefined> extends BaseSchema<InferTupleInput<TItems$1>, InferTupleOutput<TItems$1>, TupleIssue | InferTupleIssue<TItems$1>> {
  /**
  * The schema type.
  */
  readonly type: "tuple";
  /**
  * The schema reference.
  */
  readonly reference: typeof tuple;
  /**
  * The expected property.
  */
  readonly expects: "Array";
  /**
  * The items schema.
  */
  readonly items: TItems$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a tuple schema.
*
* Hint: This schema removes unknown items. The output will only include the
* items you specify. To include unknown items, use `looseTuple`. To
* return an issue for unknown items, use `strictTuple`. To include and
* validate unknown items, use `tupleWithRest`.
*
* @param items The items schema.
*
* @returns A tuple schema.
*/
declare function tuple<const TItems$1 extends TupleItems>(items: TItems$1): TupleSchema<TItems$1, undefined>;
/**
* Creates a tuple schema.
*
* Hint: This schema removes unknown items. The output will only include the
* items you specify. To include unknown items, use `looseTuple`. To
* return an issue for unknown items, use `strictTuple`. To include and
* validate unknown items, use `tupleWithRest`.
*
* @param items The items schema.
* @param message The error message.
*
* @returns A tuple schema.
*/
declare function tuple<const TItems$1 extends TupleItems, const TMessage extends ErrorMessage<TupleIssue> | undefined>(items: TItems$1, message: TMessage): TupleSchema<TItems$1, TMessage>;
//#endregion
//#region src/schemas/tuple/tupleAsync.d.ts
/**
* Tuple schema async interface.
*/
interface TupleSchemaAsync<TItems$1 extends TupleItemsAsync, TMessage extends ErrorMessage<TupleIssue> | undefined> extends BaseSchemaAsync<InferTupleInput<TItems$1>, InferTupleOutput<TItems$1>, TupleIssue | InferTupleIssue<TItems$1>> {
  /**
  * The schema type.
  */
  readonly type: "tuple";
  /**
  * The schema reference.
  */
  readonly reference: typeof tuple | typeof tupleAsync;
  /**
  * The expected property.
  */
  readonly expects: "Array";
  /**
  * The items schema.
  */
  readonly items: TItems$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a tuple schema.
*
* Hint: This schema removes unknown items. The output will only include the
* items you specify. To include unknown items, use `looseTupleAsync`. To
* return an issue for unknown items, use `strictTupleAsync`. To include and
* validate unknown items, use `tupleWithRestAsync`.
*
* @param items The items schema.
*
* @returns A tuple schema.
*/
declare function tupleAsync<const TItems$1 extends TupleItemsAsync>(items: TItems$1): TupleSchemaAsync<TItems$1, undefined>;
/**
* Creates a tuple schema.
*
* Hint: This schema removes unknown items. The output will only include the
* items you specify. To include unknown items, use `looseTupleAsync`. To
* return an issue for unknown items, use `strictTupleAsync`. To include and
* validate unknown items, use `tupleWithRestAsync`.
*
* @param items The items schema.
* @param message The error message.
*
* @returns A tuple schema.
*/
declare function tupleAsync<const TItems$1 extends TupleItemsAsync, const TMessage extends ErrorMessage<TupleIssue> | undefined>(items: TItems$1, message: TMessage): TupleSchemaAsync<TItems$1, TMessage>;
//#endregion
//#region src/schemas/tupleWithRest/types.d.ts
/**
* Tuple with rest issue interface.
*/
interface TupleWithRestIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "tuple_with_rest";
  /**
  * The expected property.
  */
  readonly expected: "Array";
}
//#endregion
//#region src/schemas/tupleWithRest/tupleWithRest.d.ts
/**
* Tuple with rest schema interface.
*/
interface TupleWithRestSchema<TItems$1 extends TupleItems, TRest$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TMessage extends ErrorMessage<TupleWithRestIssue> | undefined> extends BaseSchema<[...InferTupleInput<TItems$1>, ...InferInput<TRest$1>[]], [...InferTupleOutput<TItems$1>, ...InferOutput<TRest$1>[]], TupleWithRestIssue | InferTupleIssue<TItems$1> | InferIssue<TRest$1>> {
  /**
  * The schema type.
  */
  readonly type: "tuple_with_rest";
  /**
  * The schema reference.
  */
  readonly reference: typeof tupleWithRest;
  /**
  * The expected property.
  */
  readonly expects: "Array";
  /**
  * The items schema.
  */
  readonly items: TItems$1;
  /**
  * The rest schema.
  */
  readonly rest: TRest$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a tuple with rest schema.
*
* @param items The items schema.
* @param rest The rest schema.
*
* @returns A tuple with rest schema.
*/
declare function tupleWithRest<const TItems$1 extends TupleItems, const TRest$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(items: TItems$1, rest: TRest$1): TupleWithRestSchema<TItems$1, TRest$1, undefined>;
/**
* Creates a tuple with rest schema.
*
* @param items The items schema.
* @param rest The rest schema.
* @param message The error message.
*
* @returns A tuple with rest schema.
*/
declare function tupleWithRest<const TItems$1 extends TupleItems, const TRest$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TMessage extends ErrorMessage<TupleWithRestIssue> | undefined>(items: TItems$1, rest: TRest$1, message: TMessage): TupleWithRestSchema<TItems$1, TRest$1, TMessage>;
//#endregion
//#region src/schemas/tupleWithRest/tupleWithRestAsync.d.ts
/**
* Tuple with rest schema async interface.
*/
interface TupleWithRestSchemaAsync<TItems$1 extends TupleItemsAsync, TRest$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TMessage extends ErrorMessage<TupleWithRestIssue> | undefined> extends BaseSchemaAsync<[...InferTupleInput<TItems$1>, ...InferInput<TRest$1>[]], [...InferTupleOutput<TItems$1>, ...InferOutput<TRest$1>[]], TupleWithRestIssue | InferTupleIssue<TItems$1> | InferIssue<TRest$1>> {
  /**
  * The schema type.
  */
  readonly type: "tuple_with_rest";
  /**
  * The schema reference.
  */
  readonly reference: typeof tupleWithRest | typeof tupleWithRestAsync;
  /**
  * The expected property.
  */
  readonly expects: "Array";
  /**
  * The items schema.
  */
  readonly items: TItems$1;
  /**
  * The rest schema.
  */
  readonly rest: TRest$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a tuple with rest schema.
*
* @param items The items schema.
* @param rest The rest schema.
*
* @returns A tuple with rest schema.
*/
declare function tupleWithRestAsync<const TItems$1 extends TupleItemsAsync, const TRest$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(items: TItems$1, rest: TRest$1): TupleWithRestSchemaAsync<TItems$1, TRest$1, undefined>;
/**
* Creates a tuple with rest schema.
*
* @param items The items schema.
* @param rest The rest schema.
* @param message The error message.
*
* @returns A tuple with rest schema.
*/
declare function tupleWithRestAsync<const TItems$1 extends TupleItemsAsync, const TRest$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TMessage extends ErrorMessage<TupleWithRestIssue> | undefined>(items: TItems$1, rest: TRest$1, message: TMessage): TupleWithRestSchemaAsync<TItems$1, TRest$1, TMessage>;
//#endregion
//#region src/schemas/undefined/undefined.d.ts
/**
* Undefined issue interface.
*/
interface UndefinedIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "undefined";
  /**
  * The expected property.
  */
  readonly expected: "undefined";
}
/**
* Undefined schema interface.
*/
interface UndefinedSchema<TMessage extends ErrorMessage<UndefinedIssue> | undefined> extends BaseSchema<undefined, undefined, UndefinedIssue> {
  /**
  * The schema type.
  */
  readonly type: "undefined";
  /**
  * The schema reference.
  */
  readonly reference: typeof undefined_;
  /**
  * The expected property.
  */
  readonly expects: "undefined";
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates an undefined schema.
*
* @returns An undefined schema.
*/
declare function undefined_(): UndefinedSchema<undefined>;
/**
* Creates an undefined schema.
*
* @param message The error message.
*
* @returns An undefined schema.
*/
declare function undefined_<const TMessage extends ErrorMessage<UndefinedIssue> | undefined>(message: TMessage): UndefinedSchema<TMessage>;
//#endregion
//#region src/schemas/undefinedable/types.d.ts
/**
* Infer undefinedable output type.
*/
type InferUndefinedableOutput<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TDefault extends DefaultAsync<TWrapped$1, undefined>> = undefined extends TDefault ? InferOutput<TWrapped$1> | undefined : InferOutput<TWrapped$1> | Extract<DefaultValue<TDefault>, undefined>;
//#endregion
//#region src/schemas/undefinedable/undefinedable.d.ts
/**
* Undefinedable schema interface.
*/
interface UndefinedableSchema<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, TDefault extends Default<TWrapped$1, undefined>> extends BaseSchema<InferInput<TWrapped$1> | undefined, InferUndefinedableOutput<TWrapped$1, TDefault>, InferIssue<TWrapped$1>> {
  /**
  * The schema type.
  */
  readonly type: "undefinedable";
  /**
  * The schema reference.
  */
  readonly reference: typeof undefinedable;
  /**
  * The expected property.
  */
  readonly expects: `(${TWrapped$1["expects"]} | undefined)`;
  /**
  * The wrapped schema.
  */
  readonly wrapped: TWrapped$1;
  /**
  * The default value.
  */
  readonly default: TDefault;
}
/**
* Creates an undefinedable schema.
*
* @param wrapped The wrapped schema.
*
* @returns An undefinedable schema.
*/
declare function undefinedable<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(wrapped: TWrapped$1): UndefinedableSchema<TWrapped$1, undefined>;
/**
* Creates an undefinedable schema.
*
* @param wrapped The wrapped schema.
* @param default_ The default value.
*
* @returns An undefinedable schema.
*/
declare function undefinedable<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>>, const TDefault extends Default<TWrapped$1, undefined>>(wrapped: TWrapped$1, default_: TDefault): UndefinedableSchema<TWrapped$1, TDefault>;
//#endregion
//#region src/schemas/undefinedable/undefinedableAsync.d.ts
/**
* Undefinedable schema async interface.
*/
interface UndefinedableSchemaAsync<TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, TDefault extends DefaultAsync<TWrapped$1, undefined>> extends BaseSchemaAsync<InferInput<TWrapped$1> | undefined, InferUndefinedableOutput<TWrapped$1, TDefault>, InferIssue<TWrapped$1>> {
  /**
  * The schema type.
  */
  readonly type: "undefinedable";
  /**
  * The schema reference.
  */
  readonly reference: typeof undefinedable | typeof undefinedableAsync;
  /**
  * The expected property.
  */
  readonly expects: `(${TWrapped$1["expects"]} | undefined)`;
  /**
  * The wrapped schema.
  */
  readonly wrapped: TWrapped$1;
  /**
  * The default value.
  */
  readonly default: TDefault;
}
/**
* Creates an undefinedable schema.
*
* @param wrapped The wrapped schema.
*
* @returns An undefinedable schema.
*/
declare function undefinedableAsync<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>>(wrapped: TWrapped$1): UndefinedableSchemaAsync<TWrapped$1, undefined>;
/**
* Creates an undefinedable schema.
*
* @param wrapped The wrapped schema.
* @param default_ The default value.
*
* @returns An undefinedable schema.
*/
declare function undefinedableAsync<const TWrapped$1 extends BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, const TDefault extends DefaultAsync<TWrapped$1, undefined>>(wrapped: TWrapped$1, default_: TDefault): UndefinedableSchemaAsync<TWrapped$1, TDefault>;
//#endregion
//#region src/schemas/unknown/unknown.d.ts
/**
* Unknown schema interface.
*/
interface UnknownSchema extends BaseSchema<unknown, unknown, never> {
  /**
  * The schema type.
  */
  readonly type: "unknown";
  /**
  * The schema reference.
  */
  readonly reference: typeof unknown;
  /**
  * The expected property.
  */
  readonly expects: "unknown";
}
/**
* Creates a unknown schema.
*
* @returns A unknown schema.
*/
declare function unknown(): UnknownSchema;
//#endregion
//#region src/schemas/variant/variant.d.ts
/**
* Variant schema interface.
*/
interface VariantSchema<TKey$1 extends string, TOptions$1 extends VariantOptions<TKey$1>, TMessage extends ErrorMessage<VariantIssue> | undefined> extends BaseSchema<InferInput<TOptions$1[number]>, InferOutput<TOptions$1[number]>, VariantIssue | InferVariantIssue<TOptions$1>> {
  /**
  * The schema type.
  */
  readonly type: "variant";
  /**
  * The schema reference.
  */
  readonly reference: typeof variant;
  /**
  * The expected property.
  */
  readonly expects: "Object";
  /**
  * The discriminator key.
  */
  readonly key: TKey$1;
  /**
  * The variant options.
  */
  readonly options: TOptions$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a variant schema.
*
* @param key The discriminator key.
* @param options The variant options.
*
* @returns A variant schema.
*/
declare function variant<const TKey$1 extends string, const TOptions$1 extends VariantOptions<TKey$1>>(key: TKey$1, options: TOptions$1): VariantSchema<TKey$1, TOptions$1, undefined>;
/**
* Creates a variant schema.
*
* @param key The discriminator key.
* @param options The variant options.
* @param message The error message.
*
* @returns An variant schema.
*/
declare function variant<const TKey$1 extends string, const TOptions$1 extends VariantOptions<TKey$1>, const TMessage extends ErrorMessage<VariantIssue> | undefined>(key: TKey$1, options: TOptions$1, message: TMessage): VariantSchema<TKey$1, TOptions$1, TMessage>;
//#endregion
//#region src/schemas/variant/variantAsync.d.ts
/**
* Variant schema async interface.
*/
interface VariantSchemaAsync<TKey$1 extends string, TOptions$1 extends VariantOptionsAsync<TKey$1>, TMessage extends ErrorMessage<VariantIssue> | undefined> extends BaseSchemaAsync<InferInput<TOptions$1[number]>, InferOutput<TOptions$1[number]>, VariantIssue | InferVariantIssue<TOptions$1>> {
  /**
  * The schema type.
  */
  readonly type: "variant";
  /**
  * The schema reference.
  */
  readonly reference: typeof variant | typeof variantAsync;
  /**
  * The expected property.
  */
  readonly expects: "Object";
  /**
  * The discriminator key.
  */
  readonly key: TKey$1;
  /**
  * The variant options.
  */
  readonly options: TOptions$1;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a variant schema.
*
* @param key The discriminator key.
* @param options The variant options.
*
* @returns A variant schema.
*/
declare function variantAsync<const TKey$1 extends string, const TOptions$1 extends VariantOptionsAsync<TKey$1>>(key: TKey$1, options: TOptions$1): VariantSchemaAsync<TKey$1, TOptions$1, undefined>;
/**
* Creates a variant schema.
*
* @param key The discriminator key.
* @param options The variant options.
* @param message The error message.
*
* @returns An variant schema.
*/
declare function variantAsync<const TKey$1 extends string, const TOptions$1 extends VariantOptionsAsync<TKey$1>, const TMessage extends ErrorMessage<VariantIssue> | undefined>(key: TKey$1, options: TOptions$1, message: TMessage): VariantSchemaAsync<TKey$1, TOptions$1, TMessage>;
//#endregion
//#region src/schemas/variant/types.d.ts
/**
* Variant issue interface.
*/
interface VariantIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "variant";
  /**
  * The expected property.
  */
  readonly expected: string;
}
/**
* Variant option schema interface.
*/
interface VariantOptionSchema<TKey$1 extends string> extends BaseSchema<unknown, unknown, VariantIssue | BaseIssue<unknown>> {
  readonly type: "variant";
  readonly reference: typeof variant;
  readonly key: string;
  readonly options: VariantOptions<TKey$1>;
  readonly message: ErrorMessage<VariantIssue> | undefined;
}
/**
* Variant option schema async interface.
*/
interface VariantOptionSchemaAsync<TKey$1 extends string> extends BaseSchemaAsync<unknown, unknown, VariantIssue | BaseIssue<unknown>> {
  readonly type: "variant";
  readonly reference: typeof variant | typeof variantAsync;
  readonly key: string;
  readonly options: VariantOptionsAsync<TKey$1>;
  readonly message: ErrorMessage<VariantIssue> | undefined;
}
/**
* Variant object entries type.
*/
type VariantObjectEntries<TKey$1 extends string> = Record<TKey$1, BaseSchema<unknown, unknown, BaseIssue<unknown>> | OptionalEntrySchema> & ObjectEntries;
/**
* Variant object entries async type.
*/
type VariantObjectEntriesAsync<TKey$1 extends string> = Record<TKey$1, BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> | OptionalEntrySchema | OptionalEntrySchemaAsync> & ObjectEntriesAsync;
/**
* Variant option type.
*/
type VariantOption<TKey$1 extends string> = LooseObjectSchema<VariantObjectEntries<TKey$1>, ErrorMessage<LooseObjectIssue> | undefined> | ObjectSchema<VariantObjectEntries<TKey$1>, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchema<VariantObjectEntries<TKey$1>, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchema<VariantObjectEntries<TKey$1>, ErrorMessage<StrictObjectIssue> | undefined> | VariantOptionSchema<TKey$1>;
/**
* Variant option async type.
*/
type VariantOptionAsync<TKey$1 extends string> = LooseObjectSchemaAsync<VariantObjectEntriesAsync<TKey$1>, ErrorMessage<LooseObjectIssue> | undefined> | ObjectSchemaAsync<VariantObjectEntriesAsync<TKey$1>, ErrorMessage<ObjectIssue> | undefined> | ObjectWithRestSchemaAsync<VariantObjectEntriesAsync<TKey$1>, BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<ObjectWithRestIssue> | undefined> | StrictObjectSchemaAsync<VariantObjectEntriesAsync<TKey$1>, ErrorMessage<StrictObjectIssue> | undefined> | VariantOptionSchemaAsync<TKey$1>;
/**
* Variant options type.
*/
type VariantOptions<TKey$1 extends string> = MaybeReadonly<VariantOption<TKey$1>[]>;
/**
* Variant options async type.
*/
type VariantOptionsAsync<TKey$1 extends string> = MaybeReadonly<(VariantOption<TKey$1> | VariantOptionAsync<TKey$1>)[]>;
/**
* Infer variant issue type.
*/
type InferVariantIssue<TOptions$1 extends VariantOptions<string> | VariantOptionsAsync<string>> = Exclude<InferIssue<TOptions$1[number]>, {
  type: "loose_object" | "object" | "object_with_rest";
}>;
//#endregion
//#region src/schemas/void/void.d.ts
/**
* Void issue interface.
*/
interface VoidIssue extends BaseIssue<unknown> {
  /**
  * The issue kind.
  */
  readonly kind: "schema";
  /**
  * The issue type.
  */
  readonly type: "void";
  /**
  * The expected property.
  */
  readonly expected: "void";
}
/**
* Void schema interface.
*/
interface VoidSchema<TMessage extends ErrorMessage<VoidIssue> | undefined> extends BaseSchema<void, void, VoidIssue> {
  /**
  * The schema type.
  */
  readonly type: "void";
  /**
  * The schema reference.
  */
  readonly reference: typeof void_;
  /**
  * The expected property.
  */
  readonly expects: "void";
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a void schema.
*
* @returns A void schema.
*/
declare function void_(): VoidSchema<undefined>;
/**
* Creates a void schema.
*
* @param message The error message.
*
* @returns A void schema.
*/
declare function void_<const TMessage extends ErrorMessage<VoidIssue> | undefined>(message: TMessage): VoidSchema<TMessage>;
//#endregion
//#region src/actions/args/args.d.ts
/**
* Schema type.
*/
type Schema$3 = LooseTupleSchema<TupleItems, ErrorMessage<LooseTupleIssue> | undefined> | StrictTupleSchema<TupleItems, ErrorMessage<StrictTupleIssue> | undefined> | TupleSchema<TupleItems, ErrorMessage<TupleIssue> | undefined> | TupleWithRestSchema<TupleItems, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<TupleWithRestIssue> | undefined>;
/**
* Args action type.
*/
interface ArgsAction<TInput$1 extends (...args: any[]) => unknown, TSchema extends Schema$3> extends BaseTransformation<TInput$1, (...args: InferInput<TSchema>) => ReturnType<TInput$1>, never> {
  /**
  * The action type.
  */
  readonly type: "args";
  /**
  * The action reference.
  */
  readonly reference: typeof args;
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
* @returns An args action.
*/
declare function args<TInput$1 extends (...args: any[]) => unknown, TSchema extends Schema$3>(schema: TSchema): ArgsAction<TInput$1, TSchema>;
//#endregion
//#region src/actions/args/argsAsync.d.ts
/**
* Schema type.
*/
type Schema$2 = LooseTupleSchema<TupleItems, ErrorMessage<LooseTupleIssue> | undefined> | LooseTupleSchemaAsync<TupleItemsAsync, ErrorMessage<LooseTupleIssue> | undefined> | StrictTupleSchema<TupleItems, ErrorMessage<StrictTupleIssue> | undefined> | StrictTupleSchemaAsync<TupleItemsAsync, ErrorMessage<StrictTupleIssue> | undefined> | TupleSchema<TupleItems, ErrorMessage<TupleIssue> | undefined> | TupleSchemaAsync<TupleItemsAsync, ErrorMessage<TupleIssue> | undefined> | TupleWithRestSchema<TupleItems, BaseSchema<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<TupleWithRestIssue> | undefined> | TupleWithRestSchemaAsync<TupleItemsAsync, BaseSchema<unknown, unknown, BaseIssue<unknown>> | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>, ErrorMessage<TupleWithRestIssue> | undefined>;
/**
* Args action async type.
*/
interface ArgsActionAsync<TInput$1 extends (...args: any[]) => unknown, TSchema extends Schema$2> extends BaseTransformation<TInput$1, (...args: InferInput<TSchema>) => Promise<Awaited<ReturnType<TInput$1>>>, never> {
  /**
  * The action type.
  */
  readonly type: "args";
  /**
  * The action reference.
  */
  readonly reference: typeof argsAsync;
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
* @returns An args action.
*/
declare function argsAsync<TInput$1 extends (...args: any[]) => unknown, TSchema extends Schema$2>(schema: TSchema): ArgsActionAsync<TInput$1, TSchema>;
//#endregion
//#region src/actions/await/awaitAsync.d.ts
/**
* Await action async interface.
*/
interface AwaitActionAsync<TInput$1 extends Promise<unknown>> extends BaseTransformationAsync<TInput$1, Awaited<TInput$1>, never> {
  /**
  * The action type.
  */
  readonly type: "await";
  /**
  * The action reference.
  */
  readonly reference: typeof awaitAsync;
}
/**
* Creates an await transformation action.
*
* @returns An await action.
*/
declare function awaitAsync<TInput$1 extends Promise<unknown>>(): AwaitActionAsync<TInput$1>;
//#endregion
//#region src/actions/base64/base64.d.ts
/**
* Base64 issue interface.
*/
interface Base64Issue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "base64";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The Base64 regex.
  */
  readonly requirement: RegExp;
}
/**
* Base64 action interface.
*/
interface Base64Action<TInput$1 extends string, TMessage extends ErrorMessage<Base64Issue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, Base64Issue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "base64";
  /**
  * The action reference.
  */
  readonly reference: typeof base64;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The Base64 regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [Base64](https://en.wikipedia.org/wiki/Base64) validation action.
*
* @returns A Base64 action.
*/
declare function base64<TInput$1 extends string>(): Base64Action<TInput$1, undefined>;
/**
* Creates a [Base64](https://en.wikipedia.org/wiki/Base64) validation action.
*
* @param message The error message.
*
* @returns A Base64 action.
*/
declare function base64<TInput$1 extends string, const TMessage extends ErrorMessage<Base64Issue<TInput$1>> | undefined>(message: TMessage): Base64Action<TInput$1, TMessage>;
//#endregion
//#region src/actions/bic/bic.d.ts
/**
* BIC issue interface.
*/
interface BicIssue<TInput$1 extends string> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "bic";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The received property.
  */
  readonly received: `"${string}"`;
  /**
  * The BIC regex.
  */
  readonly requirement: RegExp;
}
/**
* BIC action interface.
*/
interface BicAction<TInput$1 extends string, TMessage extends ErrorMessage<BicIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, BicIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "bic";
  /**
  * The action reference.
  */
  readonly reference: typeof bic;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The BIC regex.
  */
  readonly requirement: RegExp;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [BIC](https://en.wikipedia.org/wiki/ISO_9362) validation action.
*
* @returns A BIC action.
*/
declare function bic<TInput$1 extends string>(): BicAction<TInput$1, undefined>;
/**
* Creates a [BIC](https://en.wikipedia.org/wiki/ISO_9362) validation action.
*
* @param message The error message.
*
* @returns A BIC action.
*/
declare function bic<TInput$1 extends string, const TMessage extends ErrorMessage<BicIssue<TInput$1>> | undefined>(message: TMessage): BicAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/brand/brand.d.ts
/**
* Brand symbol.
*/
declare const BrandSymbol: unique symbol;
/**
* Brand name type.
*/
type BrandName = string | number | symbol;
/**
* Brand interface.
*/
interface Brand<TName extends BrandName> {
  [BrandSymbol]: { [TValue in TName]: TValue };
}
/**
* Brand action interface.
*/
interface BrandAction<TInput$1, TName extends BrandName> extends BaseTransformation<TInput$1, TInput$1 & Brand<TName>, never> {
  /**
  * The action type.
  */
  readonly type: "brand";
  /**
  * The action reference.
  */
  readonly reference: typeof brand;
  /**
  * The brand name.
  */
  readonly name: TName;
}
/**
* Creates a brand transformation action.
*
* @param name The brand name.
*
* @returns A brand action.
*/
declare function brand<TInput$1, TName extends BrandName>(name: TName): BrandAction<TInput$1, TName>;
//#endregion
//#region src/actions/bytes/bytes.d.ts
/**
* Bytes issue interface.
*/
interface BytesIssue<TInput$1 extends string, TRequirement extends number> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "bytes";
  /**
  * The expected property.
  */
  readonly expected: `${TRequirement}`;
  /**
  * The received property.
  */
  readonly received: `${number}`;
  /**
  * The required bytes.
  */
  readonly requirement: TRequirement;
}
/**
* Bytes action interface.
*/
interface BytesAction<TInput$1 extends string, TRequirement extends number, TMessage extends ErrorMessage<BytesIssue<TInput$1, TRequirement>> | undefined> extends BaseValidation<TInput$1, TInput$1, BytesIssue<TInput$1, TRequirement>> {
  /**
  * The action type.
  */
  readonly type: "bytes";
  /**
  * The action reference.
  */
  readonly reference: typeof bytes;
  /**
  * The expected property.
  */
  readonly expects: `${TRequirement}`;
  /**
  * The required bytes.
  */
  readonly requirement: TRequirement;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a [bytes](https://en.wikipedia.org/wiki/Byte) validation action.
*
* @param requirement The required bytes.
*
* @returns A bytes action.
*/
declare function bytes<TInput$1 extends string, const TRequirement extends number>(requirement: TRequirement): BytesAction<TInput$1, TRequirement, undefined>;
/**
* Creates a [bytes](https://en.wikipedia.org/wiki/Byte) validation action.
*
* @param requirement The required bytes.
* @param message The error message.
*
* @returns A bytes action.
*/
declare function bytes<TInput$1 extends string, const TRequirement extends number, const TMessage extends ErrorMessage<BytesIssue<TInput$1, TRequirement>> | undefined>(requirement: TRequirement, message: TMessage): BytesAction<TInput$1, TRequirement, TMessage>;
//#endregion
//#region src/actions/check/types.d.ts
/**
* Check issue interface.
*/
interface CheckIssue<TInput$1> extends BaseIssue<TInput$1> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "check";
  /**
  * The expected property.
  */
  readonly expected: null;
  /**
  * The validation function.
  */
  readonly requirement: (input: TInput$1) => MaybePromise<boolean>;
}
//#endregion
//#region src/actions/check/check.d.ts
/**
* Check action interface.
*/
interface CheckAction<TInput$1, TMessage extends ErrorMessage<CheckIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, CheckIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "check";
  /**
  * The action reference.
  */
  readonly reference: typeof check;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The validation function.
  */
  readonly requirement: (input: TInput$1) => boolean;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a check validation action.
*
* @param requirement The validation function.
*
* @returns A check action.
*/
declare function check<TInput$1>(requirement: (input: TInput$1) => boolean): CheckAction<TInput$1, undefined>;
/**
* Creates a check validation action.
*
* @param requirement The validation function.
* @param message The error message.
*
* @returns A check action.
*/
declare function check<TInput$1, const TMessage extends ErrorMessage<CheckIssue<TInput$1>> | undefined>(requirement: (input: TInput$1) => boolean, message: TMessage): CheckAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/check/checkAsync.d.ts
/**
* Check action async interface.
*/
interface CheckActionAsync<TInput$1, TMessage extends ErrorMessage<CheckIssue<TInput$1>> | undefined> extends BaseValidationAsync<TInput$1, TInput$1, CheckIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "check";
  /**
  * The action reference.
  */
  readonly reference: typeof checkAsync;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The validation function.
  */
  readonly requirement: (input: TInput$1) => MaybePromise<boolean>;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
/**
* Creates a check validation action.
*
* @param requirement The validation function.
*
* @returns A check action.
*/
declare function checkAsync<TInput$1>(requirement: (input: TInput$1) => MaybePromise<boolean>): CheckActionAsync<TInput$1, undefined>;
/**
* Creates a check validation action.
*
* @param requirement The validation function.
* @param message The error message.
*
* @returns A check action.
*/
declare function checkAsync<TInput$1, const TMessage extends ErrorMessage<CheckIssue<TInput$1>> | undefined>(requirement: (input: TInput$1) => MaybePromise<boolean>, message: TMessage): CheckActionAsync<TInput$1, TMessage>;
//#endregion
//#region src/actions/types.d.ts
/**
* Array input type.
*/
type ArrayInput = MaybeReadonly<unknown[]>;
/**
* Array requirement type.
*/
type ArrayRequirement<TInput$1 extends ArrayInput> = (item: TInput$1[number], index: number, array: TInput$1) => boolean;
/**
* Array requirement async type.
*/
type ArrayRequirementAsync<TInput$1 extends ArrayInput> = (item: TInput$1[number], index: number, array: TInput$1) => MaybePromise<boolean>;
/**
* Content input type.
*/
type ContentInput = string | MaybeReadonly<unknown[]>;
/**
* Content requirement type.
*/
type ContentRequirement<TInput$1 extends ContentInput> = TInput$1 extends readonly unknown[] ? TInput$1[number] : TInput$1;
/**
* Entries input type.
*/
type EntriesInput = Record<string | number, unknown>;
/**
* Length input type.
*/
type LengthInput = string | ArrayLike<unknown>;
/**
* Size input type.
*/
type SizeInput = Blob | Map<unknown, unknown> | Set<unknown>;
/**
* Value input type.
*/
type ValueInput = string | number | bigint | boolean | Date;
//#endregion
//#region src/actions/checkItems/types.d.ts
/**
* Check items issue interface.
*/
interface CheckItemsIssue<TInput$1 extends ArrayInput> extends BaseIssue<TInput$1[number]> {
  /**
  * The issue kind.
  */
  readonly kind: "validation";
  /**
  * The issue type.
  */
  readonly type: "check_items";
  /**
  * The expected input.
  */
  readonly expected: null;
  /**
  * The validation function.
  */
  readonly requirement: ArrayRequirementAsync<TInput$1>;
}
//#endregion
//#region src/actions/checkItems/checkItems.d.ts
/**
* Check items action interface.
*/
interface CheckItemsAction<TInput$1 extends ArrayInput, TMessage extends ErrorMessage<CheckItemsIssue<TInput$1>> | undefined> extends BaseValidation<TInput$1, TInput$1, CheckItemsIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "check_items";
  /**
  * The action reference.
  */
  readonly reference: typeof checkItems;
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
* Creates an check items validation action.
*
* @param requirement The validation function.
*
* @returns An check items action.
*/
declare function checkItems<TInput$1 extends ArrayInput>(requirement: ArrayRequirement<TInput$1>): CheckItemsAction<TInput$1, undefined>;
/**
* Creates an check items validation action.
*
* @param requirement The validation function.
* @param message The error message.
*
* @returns An check items action.
*/
declare function checkItems<TInput$1 extends ArrayInput, const TMessage extends ErrorMessage<CheckItemsIssue<TInput$1>> | undefined>(requirement: ArrayRequirement<TInput$1>, message: TMessage): CheckItemsAction<TInput$1, TMessage>;
//#endregion
//#region src/actions/checkItems/checkItemsAsync.d.ts
/**
* Check items action async interface.
*/
interface CheckItemsActionAsync<TInput$1 extends ArrayInput, TMessage extends ErrorMessage<CheckItemsIssue<TInput$1>> | undefined> extends BaseValidationAsync<TInput$1, TInput$1, CheckItemsIssue<TInput$1>> {
  /**
  * The action type.
  */
  readonly type: "check_items";
  /**
  * The action reference.
  */
  readonly reference: typeof checkItemsAsync;
  /**
  * The expected property.
  */
  readonly expects: null;
  /**
  * The validation function.
  */
  readonly requirement: ArrayRequirementAsync<TInput$1>;
  /**
  * The error message.
  */
  readonly message: TMessage;
}
export { SchemaWithPick, pick, Schema$5, RequiredEntries$1, SchemaWithRequired, required, Schema$4, RequiredEntries, SchemaWithRequiredAsync, requiredAsync, SafeParseResult, safeParse, safeParseAsync, SafeParser, safeParser, SafeParserAsync, safeParserAsync, summarize, unwrap, BaseMetadata, GenericMetadata, UnknownDataset, SuccessDataset, PartialDataset, FailureDataset, OutputDataset, StandardProps, StandardResult, StandardSuccessResult, StandardFailureResult, StandardIssue, StandardPathItem, StandardTypes, BaseSchema, BaseSchemaAsync, GenericSchema, GenericSchemaAsync, BaseTransformation, BaseTransformationAsync, GenericTransformation, GenericTransformationAsync, BaseValidation, BaseValidationAsync, GenericValidation, GenericValidationAsync, InferInput, InferOutput, InferIssue, IsAny, IsNever, NonNullable$1, NonNullish, NonOptional, MaybeReadonly, DeepReadonly, MaybeDeepReadonly, MaybePromise, Prettify, MarkOptional, Merge, FirstTupleItem, LastTupleItem, UnionToIntersect, UnionToTupleHelper, UnionToTuple, ErrorMessage, Default, DefaultAsync, DefaultValue, OptionalEntrySchema, OptionalEntrySchemaAsync, ObjectEntries, ObjectEntriesAsync, ObjectKeys, InferEntriesInput, InferEntriesOutput, OptionalInputKeys, OptionalOutputKeys, InputWithQuestionMarks, OutputWithQuestionMarks, ReadonlyOutputKeys, OutputWithReadonly, InferObjectInput, InferObjectOutput, InferObjectIssue, TupleItems, TupleItemsAsync, InferTupleInput, InferTupleOutput, InferTupleIssue, ArrayPathItem, MapPathItem, ObjectPathItem, SetPathItem, UnknownPathItem, IssuePathItem, BaseIssue, GenericIssue, DotPath, ObjectPath, TupleKeys, TuplePath, IssueDotPath, Config, PipeAction, PipeActionAsync, PipeItem, PipeItemAsync, SchemaWithoutPipe, GenericPipeAction, GenericPipeActionAsync, GenericPipeItem, GenericPipeItemAsync, AnySchema, any, ArrayIssue, ArraySchema, array, ArraySchemaAsync, arrayAsync, BigintIssue, BigintSchema, bigint, BlobIssue, BlobSchema, blob, BooleanIssue, BooleanSchema, boolean, CustomIssue, Check, CustomSchema, custom, CheckAsync, CustomSchemaAsync, customAsync, DateIssue, DateSchema, date, Enum, EnumValues, EnumIssue, EnumSchema, enum_, ExactOptionalSchema, exactOptional, ExactOptionalSchemaAsync, exactOptionalAsync, FileIssue, FileSchema, file, FunctionIssue, FunctionSchema, function_, Class, InstanceIssue, InstanceSchema, instance, IntersectIssue, IntersectOptions, IntersectOptionsAsync, InferOption, InferIntersectInput, InferIntersectOutput, IntersectSchema, intersect, IntersectSchemaAsync, intersectAsync, LazySchema, lazy, LazySchemaAsync, lazyAsync, Literal, LiteralIssue, LiteralSchema, literal, LooseObjectIssue, LooseObjectSchema, looseObject, LooseObjectSchemaAsync, looseObjectAsync, LooseTupleIssue, LooseTupleSchema, looseTuple, LooseTupleSchemaAsync, looseTupleAsync, MapIssue, InferMapInput, InferMapOutput, MapSchema, map, MapSchemaAsync, mapAsync, NanIssue, NanSchema, nan, NeverIssue, NeverSchema, never, UnionIssue, UnionOptions, UnionSchema, union, UnionOptionsAsync, UnionSchemaAsync, unionAsync, NonNullableIssue, InferNonNullableInput, InferNonNullableOutput, InferNonNullableIssue, NonNullableSchema, nonNullable, NonNullableSchemaAsync, nonNullableAsync, NonNullishIssue, InferNonNullishInput, InferNonNullishOutput, InferNonNullishIssue, NonNullishSchema, nonNullish, NonNullishSchemaAsync, nonNullishAsync, NonOptionalIssue, InferNonOptionalInput, InferNonOptionalOutput, InferNonOptionalIssue, NonOptionalSchema, nonOptional, NonOptionalSchemaAsync, nonOptionalAsync, NullIssue, NullSchema, null_, InferNullableOutput, NullableSchema, nullable, NullableSchemaAsync, nullableAsync, InferNullishOutput, NullishSchema, nullish, NullishSchemaAsync, nullishAsync, NumberIssue, NumberSchema, number, ObjectIssue, ObjectSchema, object, ObjectSchemaAsync, objectAsync, ObjectWithRestIssue, ObjectWithRestSchema, objectWithRest, ObjectWithRestSchemaAsync, objectWithRestAsync, InferOptionalOutput, OptionalSchema, optional, OptionalSchemaAsync, optionalAsync, PicklistOptions, PicklistIssue, PicklistSchema, picklist, PromiseIssue, PromiseSchema, promise, RecordIssue, IsLiteral, OptionalKeys, WithQuestionMarks, WithReadonly, InferRecordInput, InferRecordOutput, RecordSchema, record, RecordSchemaAsync, recordAsync, SetIssue, InferSetInput, InferSetOutput, SetSchema, set, SetSchemaAsync, setAsync, StrictObjectIssue, StrictObjectSchema, strictObject, StrictObjectSchemaAsync, strictObjectAsync, StrictTupleIssue, StrictTupleSchema, strictTuple, StrictTupleSchemaAsync, strictTupleAsync, StringIssue, StringSchema, string, SymbolIssue, SymbolSchema, symbol, TupleIssue, TupleSchema, tuple, TupleSchemaAsync, tupleAsync, TupleWithRestIssue, TupleWithRestSchema, tupleWithRest, TupleWithRestSchemaAsync, tupleWithRestAsync, UndefinedIssue, UndefinedSchema, undefined_, InferUndefinedableOutput, UndefinedableSchema, undefinedable, UndefinedableSchemaAsync, undefinedableAsync, UnknownSchema, unknown, VariantSchema, variant, VariantSchemaAsync, variantAsync, VariantIssue, VariantOptionSchema, VariantOptionSchemaAsync, VariantObjectEntries, VariantObjectEntriesAsync, VariantOption, VariantOptionAsync, VariantOptions, VariantOptionsAsync, InferVariantIssue, VoidIssue, VoidSchema, void_, Schema$3, ArgsAction, args, Schema$2, ArgsActionAsync, argsAsync, AwaitActionAsync, awaitAsync, Base64Issue, Base64Action, base64, BicIssue, BicAction, bic, BrandSymbol, BrandName, Brand, BrandAction, brand, BytesIssue, BytesAction, bytes, CheckIssue, CheckAction, check, CheckActionAsync, checkAsync, ArrayInput, ArrayRequirement, ArrayRequirementAsync, ContentInput, ContentRequirement, EntriesInput, LengthInput, SizeInput, ValueInput, CheckItemsIssue, CheckItemsAction, checkItems, CheckItemsActionAsync };
