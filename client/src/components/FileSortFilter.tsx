import React from 'react';
import './FileSortFilter.css';

type SortOption = 'name' | 'date' | 'size' | 'type';
type SortOrder = 'asc' | 'desc';
type FilterOption = 'all' | 'images' | 'videos' | 'documents' | 'folders';

interface FileSortFilterProps {
  sortBy: SortOption;
  sortOrder: SortOrder;
  filterBy: FilterOption;
  viewMode: 'grid' | 'list';
  onSortChange: (sort: SortOption) => void;
  onSortOrderChange: (order: SortOrder) => void;
  onFilterChange: (filter: FilterOption) => void;
  onViewModeChange: (mode: 'grid' | 'list') => void;
}

const FileSortFilter: React.FC<FileSortFilterProps> = ({
  sortBy,
  sortOrder,
  filterBy,
  viewMode,
  onSortChange,
  onSortOrderChange,
  onFilterChange,
  onViewModeChange,
}) => {
  const filters: { value: FilterOption; label: string }[] = [
    { value: 'all', label: 'All files' }, { value: 'documents', label: 'Documents' },
    { value: 'images', label: 'Images' }, { value: 'videos', label: 'Videos' }, { value: 'folders', label: 'Folders' },
  ];
  return (
    <div className="file-sort-filter">
      <div className="file-type-filters" role="group" aria-label="Filter by file type">
        {filters.map(filter => <button key={filter.value} className={`file-type-filter ${filterBy === filter.value ? 'active' : ''}`} aria-pressed={filterBy === filter.value} onClick={() => onFilterChange(filter.value)}>{filter.label}</button>)}
      </div>
      <div className="file-display-controls">
        <select aria-label="Sort files by" value={sortBy} onChange={event => onSortChange(event.target.value as SortOption)} className="file-sort-filter-select">
          <option value="name">Name</option><option value="date">Date added</option><option value="size">Size</option><option value="type">Type</option>
        </select>
        <button onClick={() => onSortOrderChange(sortOrder === 'asc' ? 'desc' : 'asc')} className="sort-order-btn" aria-label={`Sort ${sortOrder === 'asc' ? 'descending' : 'ascending'}`} title={`Sort ${sortOrder === 'asc' ? 'descending' : 'ascending'}`}>{sortOrder === 'asc' ? '↑' : '↓'}</button>
        <div className="view-toggle" role="group" aria-label="File layout">
          <button onClick={() => onViewModeChange('grid')} className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`} aria-label="Grid view" aria-pressed={viewMode === 'grid'} title="Grid view"><svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="2" y="2" width="6" height="6" rx="1"/><rect x="12" y="2" width="6" height="6" rx="1"/><rect x="2" y="12" width="6" height="6" rx="1"/><rect x="12" y="12" width="6" height="6" rx="1"/></svg></button>
          <button onClick={() => onViewModeChange('list')} className={`view-btn ${viewMode === 'list' ? 'active' : ''}`} aria-label="List view" aria-pressed={viewMode === 'list'} title="List view"><svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M7 4h11M7 10h11M7 16h11M2 4h1M2 10h1M2 16h1" strokeLinecap="round"/></svg></button>
        </div>
      </div>
    </div>
  );
};
export default FileSortFilter;
export type { SortOption, SortOrder, FilterOption };
