create index if not exists bv_request_approved_by on public.bv_requests(approved_by);
create index if not exists bv_request_deleted_by on public.bv_requests(deleted_by);
