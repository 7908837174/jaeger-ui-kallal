// Copyright (c) 2019 The Jaeger Authors.
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

import React from 'react';
import { SpanReference } from '../../../types/trace';
import { getUrl } from '.';

type ReferenceLinkProps = {
  reference: SpanReference;
  children: React.ReactNode;
  className?: string;
  focusSpan: (spanID: string) => void;
  onClick?: () => void;
};

export default function ReferenceLink(props: ReferenceLinkProps) {
  const { reference, children, className, focusSpan, ...otherProps } = props;
  delete otherProps.onClick;
  if (reference.span) {
    return (
      <a 
        role="button" 
        onClick={(e) => {
          e.preventDefault();
          // Don't close the source span when clicking on a linked span
          focusSpan(reference.spanID);
        }} 
        className={className} 
        {...otherProps}
      >
        {children}
      </a>
    );
  }
  return (
    <a
      href={getUrl(reference.traceID, reference.spanID)}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      {...otherProps}
    >
      {children}
    </a>
  );
}