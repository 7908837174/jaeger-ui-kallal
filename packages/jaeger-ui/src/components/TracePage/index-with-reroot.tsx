// Copyright (c) 2017 Uber Technologies, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as React from 'react';
import { InputRef } from 'antd';
import { Location, History as RouterHistory } from 'history';
import _clamp from 'lodash/clamp';
import _get from 'lodash/get';
import _mapValues from 'lodash/mapValues';
import _memoize from 'lodash/memoize';
import { connect } from 'react-redux';
import { bindActionCreators, Dispatch } from 'redux';

import ArchiveNotifier from './ArchiveNotifier';
import { actions as archiveActions } from './ArchiveNotifier/duck';
import { trackFilter, trackFocusMatches, trackNextMatch, trackPrevMatch, trackRange } from './index.track';
import {
  CombokeysHandler,
  merge as mergeShortcuts,
  reset as resetShortcuts,
  ShortcutCallbacks,
} from './keyboard-shortcuts';
import { cancel as cancelScroll, scrollBy, scrollTo } from './scroll-page';
import ScrollManager from './ScrollManager';
import calculateTraceDagEV from './TraceGraph/calculateTraceDagEV';
import TraceGraph from './TraceGraph/TraceGraph';
import { TEv } from './TraceGraph/types';
import { trackSlimHeaderToggle } from './TracePageHeader/TracePageHeader.track';
import TracePageHeader from './TracePageHeader';
import TraceTimelineViewer from './TraceTimelineViewer';
import { actions as timelineActions } from './TraceTimelineViewer/duck';
import { TUpdateViewRangeTimeFunction, IViewRange, ViewRangeTimeUpdate, ETraceViewType } from './types';
import { getLocation, getUrl } from './url';
import ErrorMessage from '../common/ErrorMessage';
import LoadingIndicator from '../common/LoadingIndicator';
import { extractUiFindFromState } from '../common/UiFindInput';
import * as jaegerApiActions from '../../actions/jaeger-api';
import { getUiFindVertexKeys } from '../TraceDiff/TraceDiffGraph/traceDiffGraphUtils';
import { fetchedState } from '../../constants';
import { FetchedTrace, LocationState, ReduxState, TNil } from '../../types';
import { Trace } from '../../types/trace';
import { TraceArchive } from '../../types/archive';
import { EmbeddedState } from '../../types/embedded';
import filterSpans from '../../utils/filter-spans';
import updateUiFind from '../../utils/update-ui-find';
import TraceStatistics from './TraceStatistics/index';
import TraceSpanView from './TraceSpanView/index';
import TraceFlamegraph from './TraceFlamegraph/index';
import { StorageCapabilities, TraceGraphConfig, TraceRepresentation } from '../../types/config';
import getConfig from '../../utils/config/get-config';
import { createSubtrace } from '../../model/trace-subtree';

import './index.css';
import memoizedTraceCriticalPath from './CriticalPath/index';
import withRouteProps from '../../utils/withRouteProps';

type TDispatchProps = {
  acknowledgeArchive: (id: string) => void;
  archiveTrace: (id: string) => void;
  fetchTrace: (id: string) => void;
  focusUiFindMatches: (trace: Trace, uiFind: string | TNil) => void;
};

type TOwnProps = {
  history: RouterHistory;
  location: Location<LocationState>;
  params: { id: string; spanId?: string };
};

type TReduxProps = {
  archiveEnabled: boolean;
  storageCapabilities: StorageCapabilities | TNil;
  archiveTraceState: TraceArchive | TNil;
  criticalPathEnabled: boolean;
  embedded: null | EmbeddedState;
  id: string;
  searchUrl: null | string;
  disableJsonView: boolean;
  trace: FetchedTrace | TNil;
  uiFind: string | TNil;
  traceGraphConfig?: TraceGraphConfig;
};

type TProps = TDispatchProps & TOwnProps & TReduxProps;

type TState = {
  headerHeight: number | TNil;
  slimView: boolean;
  viewType: ETraceViewType;
  viewRange: IViewRange;
  currentRepresentation: string;
  transformedTrace: Trace | null;
  subtrace: Trace | null;
};

// export for tests
export const VIEW_MIN_RANGE = 0.01;
const VIEW_CHANGE_BASE = 0.005;
const VIEW_CHANGE_FAST = 0.05;

// export for tests
export const shortcutConfig: { [name: string]: [number, number] } = {
  panLeft: [-VIEW_CHANGE_BASE, -VIEW_CHANGE_BASE],
  panLeftFast: [-VIEW_CHANGE_FAST, -VIEW_CHANGE_FAST],
  panRight: [VIEW_CHANGE_BASE, VIEW_CHANGE_BASE],
  panRightFast: [VIEW_CHANGE_FAST, VIEW_CHANGE_FAST],
  zoomIn: [VIEW_CHANGE_BASE, -VIEW_CHANGE_BASE],
  zoomInFast: [VIEW_CHANGE_FAST, -VIEW_CHANGE_FAST],
  zoomOut: [-VIEW_CHANGE_BASE, VIEW_CHANGE_BASE],
  zoomOutFast: [-VIEW_CHANGE_FAST, VIEW_CHANGE_FAST],
};

// export for tests
export function makeShortcutCallbacks(adjRange: (start: number, end: number) => void): ShortcutCallbacks {
  function getHandler([startChange, endChange]: [number, number]): CombokeysHandler {
    return function combokeyHandler(event: React.KeyboardEvent<HTMLElement>) {
      event.preventDefault();
      adjRange(startChange, endChange);
    };
  }
  return _mapValues(shortcutConfig, getHandler);
}

// export for tests
export class TracePageImpl extends React.PureComponent<TProps, TState> {
  state: TState;

  _headerElm: HTMLElement | TNil;
  _filterSpans: typeof filterSpans;
  _searchBar: React.RefObject<InputRef>;
  _scrollManager: ScrollManager;
  traceDagEV: TEv | TNil;

  constructor(props: TProps) {
    super(props);
    const { embedded, trace } = props;
    const config = getConfig();
    const defaultRepresentation = config.traceRepresentations && config.traceRepresentations.length > 0
      ? config.traceRepresentations[0].name
      : 'Original';
    
    this.state = {
      headerHeight: null,
      slimView: Boolean(embedded && embedded.timeline.collapseTitle),
      viewType: ETraceViewType.TraceTimelineViewer,
      viewRange: {
        time: {
          current: [0, 1],
        },
      },
      currentRepresentation: defaultRepresentation,
      transformedTrace: null,
      subtrace: null,
    };
    this._headerElm = null;
    this._filterSpans = _memoize(
      filterSpans,
      // Do not use the memo if the filter text or trace has changed.
      // trace.data.spans is populated after the initial render via mutation.
      textFilter =>
        `${textFilter} ${_get(this.props.trace, 'traceID')} ${_get(this.props.trace, 'data.spans.length')}`
    );
    this._scrollManager = new ScrollManager(trace && trace.data, {
      scrollBy,
      scrollTo,
    });
    this._searchBar = React.createRef();
    resetShortcuts();
  }

  componentDidMount() {
    this.ensureTraceFetched();
    this.updateViewRangeTime(0, 1);
    /* istanbul ignore if */
    if (!this._scrollManager) {
      throw new Error('Invalid state - scrollManager is unset');
    }
    const { scrollPageDown, scrollPageUp, scrollToNextVisibleSpan, scrollToPrevVisibleSpan } =
      this._scrollManager;
    const adjViewRange = (a: number, b: number) => this._adjustViewRange(a, b, 'kbd');
    const shortcutCallbacks = makeShortcutCallbacks(adjViewRange);
    shortcutCallbacks.scrollPageDown = scrollPageDown;
    shortcutCallbacks.scrollPageUp = scrollPageUp;
    shortcutCallbacks.scrollToNextVisibleSpan = scrollToNextVisibleSpan;
    shortcutCallbacks.scrollToPrevVisibleSpan = scrollToPrevVisibleSpan;
    shortcutCallbacks.clearSearch = this.clearSearch;
    shortcutCallbacks.searchSpans = this.focusOnSearchBar;
    mergeShortcuts(shortcutCallbacks);
    
    // Check if we need to create a subtrace based on spanId in URL
    this.createSubtraceIfNeeded();
  }

  componentDidUpdate({ id: prevID, trace: prevTrace, params: prevParams }: TProps) {
    const { id, trace, params } = this.props;
    const { currentRepresentation } = this.state;

    this._scrollManager.setTrace(trace && trace.data);

    this.setHeaderHeight(this._headerElm);
    if (!trace) {
      this.ensureTraceFetched();
      return;
    }
    
    // If the trace has changed, apply the current representation
    if (trace && (!prevTrace || prevTrace.data !== trace.data)) {
      const config = getConfig();
      const representation = config.traceRepresentations?.find(r => r.name === currentRepresentation);
      if (representation) {
        this.setTraceRepresentation(representation);
      }
      
      // Check if we need to create a subtrace based on spanId in URL
      this.createSubtraceIfNeeded();
    }
    
    // If the spanId param has changed, update the subtrace
    if (params.spanId !== prevParams.spanId) {
      this.createSubtraceIfNeeded();
    }
    
    if (prevID !== id) {
      this.updateViewRangeTime(0, 1);
      this.clearSearch();
    }
  }

  componentWillUnmount() {
    resetShortcuts();
    cancelScroll();
    this._scrollManager.destroy();
    this._scrollManager = new ScrollManager(undefined, {
      scrollBy,
      scrollTo,
    });
  }

  createSubtraceIfNeeded() {
    const { trace, params } = this.props;
    const { spanId } = params;
    
    if (trace && trace.data && spanId) {
      const subtrace = createSubtrace(trace.data, spanId);
      this.setState({ subtrace });
    } else {
      this.setState({ subtrace: null });
    }
  }

  rerootTrace = (spanId: string) => {
    const { history, location, params } = this.props;
    const { id } = params;
    
    // Navigate to the URL with the spanId
    history.push(getLocation(id, location.state, undefined, spanId));
  };

  resetRootTrace = () => {
    const { history, location, params } = this.props;
    const { id } = params;
    
    // Navigate to the URL without the spanId
    history.push(getLocation(id, location.state));
  };

  _adjustViewRange(startChange: number, endChange: number, trackSrc: string) {
    const [viewStart, viewEnd] = this.state.viewRange.time.current;
    let start = _clamp(viewStart + startChange, 0, 0.99);
    let end = _clamp(viewEnd + endChange, 0.01, 1);
    if (end - start < VIEW_MIN_RANGE) {
      if (startChange < 0 && endChange < 0) {
        end = start + VIEW_MIN_RANGE;
      } else if (startChange > 0 && endChange > 0) {
        end = start + VIEW_MIN_RANGE;
      } else {
        const center = viewStart + (viewEnd - viewStart) / 2;
        start = center - VIEW_MIN_RANGE / 2;
        end = center + VIEW_MIN_RANGE / 2;
      }
    }
    this.updateViewRangeTime(start, end, trackSrc);
  }

  setHeaderHeight = (elm: HTMLElement | TNil) => {
    this._headerElm = elm;
    if (elm) {
      if (this.state.headerHeight !== elm.clientHeight) {
        this.setState({ headerHeight: elm.clientHeight });
      }
    } else if (this.state.headerHeight) {
      this.setState({ headerHeight: null });
    }
  };

  clearSearch = () => {
    const { history, location } = this.props;
    updateUiFind({
      history,
      location,
      trackFindFunction: trackFilter,
    });
    if (this._searchBar.current) this._searchBar.current.blur();
  };

  focusOnSearchBar = () => {
    if (this._searchBar.current) this._searchBar.current.focus();
  };

  updateViewRangeTime: TUpdateViewRangeTimeFunction = (start: number, end: number, trackSrc?: string) => {
    if (trackSrc) {
      trackRange(trackSrc, [start, end], this.state.viewRange.time.current);
    }
    const current: [number, number] = [start, end];
    const time = { current };
    this.setState((state: TState) => ({ viewRange: { ...state.viewRange, time } }));
  };

  updateNextViewRangeTime = (update: ViewRangeTimeUpdate) => {
    this.setState((state: TState) => {
      const time = { ...state.viewRange.time, ...update };
      return { viewRange: { ...state.viewRange, time } };
    });
  };

  toggleSlimView = () => {
    const { slimView } = this.state;
    trackSlimHeaderToggle(!slimView);
    this.setState({ slimView: !slimView });
  };

  setTraceView = (viewType: ETraceViewType) => {
    if (this.props.trace && this.props.trace.data && viewType === ETraceViewType.TraceGraph) {
      this.traceDagEV = calculateTraceDagEV(this.props.trace.data);
    }
    this.setState({ viewType });
  };

  setTraceRepresentation = (representation: TraceRepresentation) => {
    const { trace } = this.props;
    if (!trace || !trace.data) return;

    try {
      // eslint-disable-next-line no-new-func
      const transformFunc = new Function('return ' + representation.transformFunction)();
      const transformedTrace = transformFunc(trace.data);
      
      this.setState({
        currentRepresentation: representation.name,
        transformedTrace,
      });
    } catch (error) {
      console.error('Error applying trace representation:', error);
    }
  };

  archiveTrace = () => {
    const { id, archiveTrace } = this.props;
    archiveTrace(id);
  };

  acknowledgeArchive = () => {
    const { id, acknowledgeArchive } = this.props;
    acknowledgeArchive(id);
  };

  ensureTraceFetched() {
    const { fetchTrace, location, trace, id } = this.props;
    if (!trace) {
      fetchTrace(id);
      return;
    }
    const { history } = this.props;
    if (id && id !== id.toLowerCase()) {
      history.replace(getLocation(id.toLowerCase(), location.state));
    }
  }

  focusUiFindMatches = () => {
    const { trace, focusUiFindMatches, uiFind } = this.props;
    if (trace && trace.data) {
      trackFocusMatches();
      focusUiFindMatches(trace.data, uiFind);
    }
  };

  nextResult = () => {
    trackNextMatch();
    this._scrollManager.scrollToNextVisibleSpan();
  };

  prevResult = () => {
    trackPrevMatch();
    this._scrollManager.scrollToPrevVisibleSpan();
  };

  render() {
    const {
      archiveEnabled,
      storageCapabilities,
      archiveTraceState,
      criticalPathEnabled,
      embedded,
      id,
      uiFind,
      trace,
      disableJsonView,
      traceGraphConfig,
      location: { state: locationState },
      params,
    } = this.props;
    const { slimView, viewType, headerHeight, viewRange, currentRepresentation, subtrace } = this.state;
    if (!trace || trace.state === fetchedState.LOADING) {
      return <LoadingIndicator className="u-mt-vast" centered />;
    }
    
    // Use the subtrace if available, otherwise use transformed trace or original trace data
    const { transformedTrace } = this.state;
    const data = subtrace || transformedTrace || trace.data;
    
    if (trace.state === fetchedState.ERROR || !data) {
      return <ErrorMessage className="ub-m3" error={trace.error || 'Unknown error'} />;
    }

    let findCount = 0;
    let graphFindMatches: Set<string> | null | undefined;
    let spanFindMatches: Set<string> | null | undefined;
    if (uiFind) {
      if (viewType === ETraceViewType.TraceGraph) {
        graphFindMatches = getUiFindVertexKeys(uiFind, _get(this.traceDagEV, 'vertices', []));
        findCount = graphFindMatches ? graphFindMatches.size : 0;
      } else {
        spanFindMatches = this._filterSpans(uiFind, _get(trace, 'data.spans'));
        findCount = spanFindMatches ? spanFindMatches.size : 0;
      }
    }

    const isEmbedded = Boolean(embedded);
    const hasArchiveStorage = Boolean(storageCapabilities?.archiveStorage);
    const isSubtrace = Boolean(subtrace);
    
    const headerProps = {
      focusUiFindMatches: this.focusUiFindMatches,
      slimView,
      textFilter: uiFind,
      viewType,
      viewRange,
      canCollapse: !embedded || !embedded.timeline.hideSummary || !embedded.timeline.hideMinimap,
      clearSearch: this.clearSearch,
      hideMap: Boolean(
        viewType !== ETraceViewType.TraceTimelineViewer || (embedded && embedded.timeline.hideMinimap)
      ),
      hideSummary: Boolean(embedded && embedded.timeline.hideSummary),
      linkToStandalone: getUrl(id),
      nextResult: this.nextResult,
      onArchiveClicked: this.archiveTrace,
      onSlimViewClicked: this.toggleSlimView,
      onTraceViewChange: this.setTraceView,
      onTraceRepresentationChange: this.setTraceRepresentation,
      currentRepresentation,
      prevResult: this.prevResult,
      ref: this._searchBar,
      resultCount: findCount,
      disableJsonView,
      showArchiveButton: !isEmbedded && archiveEnabled && hasArchiveStorage,
      showShortcutsHelp: !isEmbedded,
      showStandaloneLink: isEmbedded,
      showViewOptions: !isEmbedded,
      toSearch: (locationState && locationState.fromSearch) || null,
      trace: data,
      updateNextViewRangeTime: this.updateNextViewRangeTime,
      updateViewRangeTime: this.updateViewRangeTime,
      isSubtrace,
      onResetRootTrace: isSubtrace ? this.resetRootTrace : undefined,
    };

    let view;
    const criticalPath = criticalPathEnabled ? memoizedTraceCriticalPath(data) : [];
    if (ETraceViewType.TraceTimelineViewer === viewType && headerHeight) {
      view = (
        <TraceTimelineViewer
          registerAccessors={this._scrollManager.setAccessors}
          scrollToFirstVisibleSpan={this._scrollManager.scrollToFirstVisibleSpan}
          findMatchesIDs={spanFindMatches}
          trace={data}
          criticalPath={criticalPath}
          updateNextViewRangeTime={this.updateNextViewRangeTime}
          updateViewRangeTime={this.updateViewRangeTime}
          viewRange={viewRange}
          onRerootClicked={this.rerootTrace}
        />
      );
    } else if (ETraceViewType.TraceGraph === viewType && headerHeight) {
      view = (
        <TraceGraph
          headerHeight={headerHeight}
          ev={this.traceDagEV}
          uiFind={uiFind}
          uiFindVertexKeys={graphFindMatches}
          traceGraphConfig={traceGraphConfig}
        />
      );
    } else if (ETraceViewType.TraceStatistics === viewType && headerHeight) {
      view = <TraceStatistics trace={data} uiFindVertexKeys={spanFindMatches} uiFind={uiFind} />;
    } else if (ETraceViewType.TraceSpansView === viewType && headerHeight) {
      view = <TraceSpanView trace={data} uiFindVertexKeys={spanFindMatches} uiFind={uiFind} />;
    } else if (ETraceViewType.TraceFlamegraph === viewType && headerHeight) {
      view = <TraceFlamegraph trace={trace} />;
    }

    return (
      <div>
        {archiveEnabled && (
          <ArchiveNotifier acknowledge={this.acknowledgeArchive} archivedState={archiveTraceState} />
        )}
        <div className="Tracepage--headerSection" ref={this.setHeaderHeight}>
          <TracePageHeader {...headerProps} />
        </div>
        {headerHeight ? <section style={{ paddingTop: headerHeight }}>{view}</section> : null}
      </div>
    );
  }
}

// export for tests
export function mapStateToProps(state: ReduxState, ownProps: TOwnProps): TReduxProps {
  const { id } = ownProps.params;
  const { archive, config, embedded, router } = state;
  const { traces } = state.trace;
  const trace = id ? traces[id] : null;
  const archiveTraceState = id ? archive[id] : null;
  const archiveEnabled = Boolean(config.archiveEnabled);
  const storageCapabilities = config.storageCapabilities;
  const { disableJsonView, criticalPathEnabled } = config;
  const { state: locationState } = router.location;
  const searchUrl = (locationState && locationState.fromSearch) || null;
  const { traceGraph: traceGraphConfig } = config;

  return {
    ...extractUiFindFromState(state),
    archiveEnabled,
    storageCapabilities,
    archiveTraceState,
    criticalPathEnabled,
    embedded,
    id,
    searchUrl,
    disableJsonView,
    trace,
    traceGraphConfig,
  };
}

// export for tests
export function mapDispatchToProps(dispatch: Dispatch<ReduxState>): TDispatchProps {
  const { fetchTrace } = bindActionCreators(jaegerApiActions, dispatch);
  const { archiveTrace, acknowledge: acknowledgeArchive } = bindActionCreators(archiveActions, dispatch);
  const { focusUiFindMatches } = bindActionCreators(timelineActions, dispatch);
  return { acknowledgeArchive, archiveTrace, fetchTrace, focusUiFindMatches };
}

export default withRouteProps(connect(mapStateToProps, mapDispatchToProps)(TracePageImpl));