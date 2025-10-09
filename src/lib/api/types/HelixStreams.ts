export interface HelixStreams {
  readonly data: readonly Stream[];
  readonly pagination: Pagination;
}

export interface Stream {
  readonly id: string;
  readonly user_id: string;
  readonly user_login: string;
  readonly user_name: string;
  readonly game_id: string;
  readonly game_name: string;
  readonly type: string;
  readonly title: string;
  readonly viewer_count: number;
  readonly started_at: string;
  readonly language: string;
  readonly thumbnail_url: string;
  readonly tag_ids: readonly string[];
  readonly tags: readonly string[];
  readonly is_mature: boolean;
}

export interface Pagination {
  readonly cursor: string;
}
